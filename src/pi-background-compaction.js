// Serialized into the bundled AgentSession by bundled-pi-patches.js.
// Keep this function self-contained: the installed runtime has no project imports.
export function installAxumBackgroundCompaction(session, helpers) {
  if (session._axumBackgroundCompaction) return;
  const { prepareCompaction, estimateProjectedContextTokens, estimateMessagesTokens, isVirtualModel } = helpers;
  const RETRY_COOLDOWN_MS = 30_000;
  const PERCENT = 100;
  let configuration;
  let job;
  let retryAfter = 0;
  const nativeAutoCompact = session._runAutoCompaction.bind(session);

  function enabled() {
    return configuration && session.model?.contextWindow > 0 && !isVirtualModel(session.model);
  }

  function cancel() {
    const previous = job;
    job = undefined;
    previous?.controller.abort();
  }

  function matches(candidate) {
    if (candidate.manager !== session.sessionManager || candidate.sessionId !== session.sessionManager.getSessionId() ||
        candidate.model !== session.model || candidate.configuration !== configuration) return false;
    const current = session.sessionManager.getBranch();
    return candidate.entries.every((entry, index) => current[index]?.id === entry.id) &&
      !current.slice(candidate.entries.length).some(entry =>
        ["compaction", "branch_summary", "context_edit"].includes(entry.type));
  }

  async function generate(candidate, preparation) {
    const signal = candidate.controller.signal;
    const runner = session._extensionRunner;
    let override;
    if (runner.hasHandlers("session_before_compact")) {
      const response = await runner.emit({
        type: "session_before_compact", preparation, branchEntries: candidate.entries,
        customInstructions: candidate.configuration.customInstructions,
        reason: "threshold", willRetry: false, signal,
      });
      if (response?.cancel) throw new Error("Compaction cancelled");
      override = response?.compaction;
    }
    signal.throwIfAborted();
    const result = override ?? await session._runDefaultCompaction(preparation, candidate.model,
      candidate.configuration.customInstructions, signal, "threshold");
    signal.throwIfAborted();
    if (!result.summary?.trim() || !candidate.entries.some(entry => entry.id === result.firstKeptEntryId)) {
      throw new Error("Background compaction produced an invalid checkpoint");
    }
    return { ...result, fromExtension: Boolean(override) };
  }

  function usage() {
    const projection = session.sessionManager.buildSessionProjection();
    return PERCENT * estimateProjectedContextTokens(projection, session.sessionManager.getBranch()).tokens /
      session.model.contextWindow;
  }

  function schedule() {
    if (!enabled()) return;
    if (job && (!matches(job) || (job.error && Date.now() >= retryAfter))) cancel();
    if (job || Date.now() < retryAfter || usage() < configuration.softThreshold) return;
    const entries = session.sessionManager.getBranch().slice();
    const preparation = prepareCompaction(entries, session.settingsManager.getCompactionSettings(session.model));
    if (!preparation) return;
    const candidate = {
      entries, manager: session.sessionManager, sessionId: session.sessionManager.getSessionId(),
      model: session.model, configuration, controller: new AbortController(),
    };
    job = candidate;
    candidate.promise = generate(candidate, preparation).then(result => {
      candidate.result = result;
    }, error => {
      candidate.error = error;
      if (!matches(candidate)) return;
      if (job !== candidate || candidate.controller.signal.aborted) return;
      retryAfter = Date.now() + RETRY_COOLDOWN_MS;
      candidate.configuration.onError?.(error);
    });
  }

  async function apply(candidate) {
    if (job !== candidate || !matches(candidate) || !candidate.result) return false;
    // No await between validation, journal append, and rebuilding the live projection.
    const { summary, firstKeptEntryId, tokensBefore, details, usage: summaryUsage, fromExtension } = candidate.result;
    session._emit({ type: "compaction_start", reason: "threshold" });
    const id = session.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, summaryUsage);
    session._refreshFinalizedContext();
    job = undefined;
    retryAfter = Date.now() + RETRY_COOLDOWN_MS;
    const result = { summary, firstKeptEntryId, tokensBefore, details, usage: summaryUsage,
      estimatedTokensAfter: estimateMessagesTokens(session.sessionManager.buildSessionProjection().messages) };
    try {
      await session._extensionRunner.emit({ type: "session_compact", compactionEntry: session.sessionManager.getEntry(id),
        fromExtension, reason: "threshold", willRetry: false, background: true });
    } finally {
      session._emit({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false });
    }
    return true;
  }

  async function waitFor(candidate, signal) {
    signal?.throwIfAborted();
    let onAbort;
    try {
      await Promise.race([candidate.promise, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("Aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      })]);
      signal?.throwIfAborted();
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async function beforeRequest(signal) {
    if (!enabled()) return;
    signal?.throwIfAborted();
    schedule();
    const candidate = job;
    if (candidate?.result) {
      await apply(candidate);
      return;
    }
    if (usage() < configuration.hardThreshold) return;
    if (candidate) {
      await waitFor(candidate, signal);
      if (job !== candidate || !matches(candidate)) return;
      if (await apply(candidate)) return;
    }
    // One controlled native retry at the hard boundary; never abort the active turn.
    cancel();
    retryAfter = Date.now() + RETRY_COOLDOWN_MS;
    await nativeAutoCompact("threshold", false);
    signal?.throwIfAborted();
  }

  session._axumBackgroundCompaction = {
    configure(options) {
      if (!configuration || ["softThreshold", "hardThreshold", "customInstructions"].some(key =>
        options[key] !== configuration[key])) {
        cancel();
        configuration = { ...options };
        retryAfter = 0;
      }
      schedule();
    },
    beforeRequest,
  };
  const compactBeforeNext = session._compactBeforeNextAssistantResponse.bind(session);
  session._compactBeforeNextAssistantResponse = async context => enabled()
    ? { ...context, messages: session.sessionManager.buildSessionProjection().messages }
    : compactBeforeNext(context);
  session._runAutoCompaction = async (reason, willRetry) => {
    if (reason === "threshold" && enabled()) {
      schedule();
      return false;
    }
    cancel();
    return nativeAutoCompact(reason, willRetry);
  };
  // These operations terminate the snapshot's authority even if the new branch
  // happens to have the same prefix. Session ID and prefix checks cover replacement too.
  for (const name of ["compact", "abortCompaction", "dispose", "reload", "navigateTree"]) {
    const original = session[name].bind(session);
    session[name] = (...args) => {
      cancel();
      return original(...args);
    };
  }
}
