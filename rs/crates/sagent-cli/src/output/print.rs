use crate::types::SseEvent;

pub fn event(ev: &SseEvent, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        println!("{}", serde_json::to_string(ev)?);
        return Ok(());
    }
    text_event(ev);
    Ok(())
}

fn text_event(ev: &SseEvent) {
    match ev.kind.as_str() {
        "step" => println!("step {} {}", ev.seq, ev.payload),
        "llm_error" => println!("llm_error {} {}", ev.seq, ev.payload),
        "done" => done(ev),
        "error" => println!("error {} {}", ev.seq, ev.payload),
        _ => println!("{} {} {}", ev.kind, ev.seq, ev.payload),
    }
}

fn done(ev: &SseEvent) {
    match ev.payload.get("answer") {
        Some(answer) => println!("done {} {}", ev.seq, answer),
        None => println!("done {} {}", ev.seq, ev.payload),
    }
}

