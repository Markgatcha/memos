use std::process;

fn main() {
    if let Err(err) = memos_desktop::cli::run_from_env() {
        eprintln!("error: {err}");
        process::exit(1);
    }
}
