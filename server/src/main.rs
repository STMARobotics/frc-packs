use std::io::IsTerminal;
use std::path::PathBuf;

use tracing_subscriber::EnvFilter;

fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

const USAGE: &str = "usage:
  frc-packs-server                         run the site
  frc-packs-server create-admin [name]     make the admin account (default name: admin) and print its password
  frc-packs-server reset-password <name>   give an account a new password and print it
  frc-packs-server ready-check             send \"free pack ready\" notifications once (for a schedule on AWS)";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        // Logs go to stderr (CloudWatch on AWS), so command output stays clean. No color codes
        // unless it's a terminal.
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let known = match args.first().map(String::as_str) {
        None => true,
        Some("create-admin") => args.len() <= 2,
        Some("reset-password") => args.len() == 2,
        Some("ready-check") => args.len() == 1,
        _ => false,
    };
    if !known {
        eprintln!("{USAGE}");
        std::process::exit(2);
    }
    // The DynamoDB table: on AWS, credentials and region come from the environment (the Lambda's role); locally, set
    // DYNAMODB_ENDPOINT to a local DynamoDB (it makes the table itself).
    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "frc-packs".into());
    let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "../data".into()));
    let db = frc_packs_server::db::connect(&table).await;
    frc_packs_server::prepare(&db).await?;
    // The scheduled copy of the function (see cdk/lib/packs-backend-stack.ts) runs the "free pack ready" check on a
    // timer instead of answering web requests.
    #[cfg(feature = "lambda")]
    if std::env::var("AWS_LAMBDA_RUNTIME_API").is_ok() && std::env::var("LAMBDA_TASK").as_deref() == Ok("ready-check") {
        use lambda_http::lambda_runtime::{LambdaEvent, run, service_fn};
        let db = db.clone();
        return run(service_fn(move |_: LambdaEvent<serde_json::Value>| {
            let db = db.clone();
            async move {
                frc_packs_server::push::ready_check(&db).await.map_err(|e| lambda_http::Error::from(e.to_string()))
            }
        }))
        .await
        .map_err(|e| anyhow::anyhow!(e));
    }
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        [] => serve(db, data_dir).await,
        ["create-admin", ref rest @ ..] if rest.len() <= 1 => {
            let catalog = frc_packs_server::packs::Catalog::load(&data_dir.join("packs"))?;
            let name = rest.first().copied().unwrap_or("admin");
            match frc_packs_server::admin::create_admin(&db, name, catalog.claimable().id()).await? {
                (name, Some(password)) => {
                    println!(
                        "Made the admin account. Sign in on the site with:\n  username: {name}\n  password: {password}"
                    );
                    println!("Change the password in Settings after signing in. Admin panel: /admin");
                }
                (name, None) => {
                    println!("The admin account already exists: {name}. Lost its password? Run: reset-password {name}")
                }
            }
            Ok(())
        }
        ["reset-password", name] => {
            let password = frc_packs_server::admin::reset_password_by_name(&db, name).await?;
            println!(
                "New password for {name}: {password}\nThey're signed out everywhere; they can change it in Settings."
            );
            Ok(())
        }
        ["ready-check"] => frc_packs_server::push::ready_check(&db).await,
        _ => unreachable!("checked above"),
    }
}

async fn serve(db: frc_packs_server::db::Db, data_dir: PathBuf) -> anyhow::Result<()> {
    let bind = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let web_dir = PathBuf::from(std::env::var("WEB_DIR").unwrap_or_else(|_| "../web/dist".into()));
    let cfg = frc_packs_server::Config {
        data_dir,
        web_dir: web_dir.join("index.html").exists().then_some(web_dir),
        dev_tools: flag("DEV_TOOLS"),
        cookie_secure: flag("COOKIE_SECURE"),
        admin_only: flag("ADMIN_ONLY"),
    };
    if cfg.dev_tools {
        tracing::warn!("DEV_TOOLS is on: anyone can give themselves packs and demo luck");
    }
    if cfg.admin_only {
        tracing::warn!("ADMIN_ONLY is on: only admin accounts can sign in");
    }
    let app = frc_packs_server::app(db.clone(), cfg)?;
    // On AWS Lambda (built with --features lambda), the same app answers Lambda's HTTP events instead of a port.
    #[cfg(feature = "lambda")]
    if std::env::var("AWS_LAMBDA_RUNTIME_API").is_ok() {
        return lambda_http::run(app).await.map_err(|e| anyhow::anyhow!(e));
    }
    // "Free pack ready" notifications, checked once a minute.
    tokio::spawn(frc_packs_server::push::ready_loop(db));
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

/// Finish in-flight requests on Ctrl-C, or on SIGTERM when run as a service.
async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    tracing::info!("shutting down");
}
