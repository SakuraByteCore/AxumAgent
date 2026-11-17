// Serialized into the bundled AgentSession by bundled-pi-patches.js.
// Keep this function self-contained: the installed runtime has no project imports.

export function installAxumSystemPromptRefresh(session, helpers) {
  if (session._axumRefreshSystemPrompt) return;
  const { existsSync, readFileSync, buildSystemPrompt } = helpers;

  function resolvePromptInput(input) {
    if (!input) return undefined;
    if (!existsSync(input)) return input;
    try {
      const content = readFileSync(input, "utf8");
      return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    } catch {
      return input;
    }
  }

  function sameStrings(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function refresh() {
    const loader = session._resourceLoader;
    const previousBasePrompt = buildSystemPrompt(session._baseSystemPromptOptions);
    const systemSource = loader.systemPromptSource ?? loader.discoverSystemPromptFile();
    const baseSystemPrompt = resolvePromptInput(systemSource);
    const nextSystemPrompt = loader.systemPromptOverride
      ? loader.systemPromptOverride(baseSystemPrompt)
      : baseSystemPrompt;
    const discoveredAppendSource = loader.discoverAppendSystemPromptFile();
    const appendSources = loader.appendSystemPromptSource
      ?? (discoveredAppendSource ? [discoveredAppendSource] : []);
    const baseAppend = appendSources
      .map((source) => resolvePromptInput(source))
      .filter((source) => source !== undefined);
    const nextAppend = loader.appendSystemPromptOverride
      ? loader.appendSystemPromptOverride(baseAppend)
      : baseAppend;
    const nextSystemSourcePath = systemSource && existsSync(systemSource) ? systemSource : undefined;
    const nextAppendSourcePaths = appendSources.filter((source) => existsSync(source));
    const changed = nextSystemPrompt !== loader.systemPrompt
      || !sameStrings(nextAppend, loader.appendSystemPrompt ?? []);

    if (!changed) return false;
    loader.systemPrompt = nextSystemPrompt;
    loader.systemPromptSourcePath = nextSystemSourcePath;
    loader.appendSystemPrompt = nextAppend;
    loader.appendSystemPromptSourcePaths = nextAppendSourcePaths;
    session._rebuildSystemPrompt(session.getActiveToolNames());
    const nextBasePrompt = buildSystemPrompt(session._baseSystemPromptOptions);
    const runOptions = session._runSystemPromptOptions;
    if (runOptions) {
      runOptions.customPrompt = session._baseSystemPromptOptions.customPrompt;
      runOptions.appendSystemPrompt = session._baseSystemPromptOptions.appendSystemPrompt;
      if (runOptions.forceSystemPrompt?.includes(previousBasePrompt)) {
        runOptions.forceSystemPrompt = runOptions.forceSystemPrompt.replace(
          previousBasePrompt,
          nextBasePrompt,
        );
      }
    }
    return true;
  }

  session._axumRefreshSystemPrompt = refresh;

  const previousPrepareRequest = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    const result = previousPrepareRequest ? await previousPrepareRequest(request, signal) : undefined;
    const context = result?.context ?? request.context;
    refresh();
    const options = session._runSystemPromptOptions ?? session._baseSystemPromptOptions;
    const updateMessage = session._preparePromptAndToolLoadout(options, context.messages);
    if (!updateMessage) return result;
    const messages = [...context.messages, updateMessage];
    return { ...result, context: { ...context, messages } };
  };
}
