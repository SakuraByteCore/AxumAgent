use std::io::Write;

use crate::types::SseEvent;

pub fn line(s: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut out = std::io::stdout().lock();
    match writeln!(out, "{s}") {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => std::process::exit(0),
        Err(e) => Err(e.into()),
    }
}

pub fn event(ev: &SseEvent, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        line(&serde_json::to_string(ev)?)?;
        return Ok(());
    }
    text_event(ev);
    Ok(())
}

fn text_event(ev: &SseEvent) {
    match ev.kind.as_str() {
        "step" => {
            let _ = line(&format!("step {} {}", ev.seq, ev.payload));
        }
        "llm_error" => {
            let _ = line(&format!("llm_error {} {}", ev.seq, ev.payload));
        }
        "done" => done(ev),
        "error" => {
            let _ = line(&format!("error {} {}", ev.seq, ev.payload));
        }
        _ => {
            let _ = line(&format!("{} {} {}", ev.kind, ev.seq, ev.payload));
        }
    }
}

fn done(ev: &SseEvent) {
    match ev.payload.get("answer") {
        Some(answer) => {
            let _ = line(&format!("done {} {}", ev.seq, answer));
        }
        None => {
            let _ = line(&format!("done {} {}", ev.seq, ev.payload));
        }
    }
}
