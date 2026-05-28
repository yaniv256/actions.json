# Bridge Architecture

## Short Version

`actions.json` is the map.

The injected JavaScript runtime is the interpreter.

The MCP adapter is the translator.

The skill is the authoring guide.

## Message Flow

1. A coding agent uses the authoring skill to explore a website.
2. The agent writes `actions.json` as durable memory of the site's operations.
3. The browser runtime is injected into the page.
4. The runtime loads `actions.json` and exposes the Actions Bridge Protocol.
5. The MCP adapter exposes the actions as tools to the coding agent.
6. The coding agent calls a tool.
7. The MCP adapter translates that call into an Actions Bridge Protocol action request.
8. The runtime receives the request, performs the DOM operation, and returns a structured result.

## Bridge Protocol

The Actions Bridge Protocol is the runtime-facing protocol for action execution.

It is modeled primarily on OpenAI Responses-style item semantics:

- typed input/output items
- explicit action/tool calls
- explicit action/tool outputs
- stable correlation IDs
- structured errors and timeouts
- transport-independent delivery

Adapters can map this protocol to OpenAI Responses, OpenAI Realtime, Anthropic Messages, MCP tools, and other agent runtimes.

## Deployment Topologies

The browser runtime and MCP adapter do not need to run on the same machine.

Supported topologies should include:

- local coding agent, local browser
- remote coding agent, local browser
- local coding agent, remote browser
- browser extension runtime, hosted model session
- embedded website runtime, hosted website agent
- shared RoomJinni-like overlay runtime

The bridge protocol can be carried by:

- direct in-process calls
- WebSocket
- tunnel
- hosted relay
- browser-extension ports
- Playwright/CDP

## RoomJinni Bypass Pattern

Usually the website plays the user side and the agent plays the assistant side.

RoomJinni proved an exception: user input may originate on the agent side, such as speech received by a Realtime agent before the website sees it. In that case, the agent runtime needs a bypass channel to inject the user request into the website/backend side, then correlate the injected request with the assistant reply when it arrives.

The public runtime should keep this pattern in mind even if the first MVP only implements the simpler coding-agent flow.
