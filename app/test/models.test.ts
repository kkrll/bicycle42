// How models are named to the reviewer (shared/models.ts) and what agents say of them
// (main/model-facts.ts): never two models that read as one, the labels a name or OpenCode's
// metadata give, and OpenCode's model list in both of its shapes.
import test from "node:test"
import assert from "node:assert/strict"
import { labelText, modelLabel, modelTags, modelWords, plainName, sharedNames } from "../src/shared/models"
import { addKeyCommand, isOpenCode, NO_PICTURES, parseModelApi, parseModelsVerbose, PICTURE_UNREAD } from "../src/main/model-facts"
import type { ModelInfo } from "../src/shared/types"

const m = (providerID: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ providerID, id: `${providerID}/${name}`, name, images: true, variants: [], ...extra })

test("names: two providers' models of one name each say their provider; a name of its own does not", () => {
  const all = [m("kimi-code-plan-global", "Kimi K3.1 Pro"), m("moonshotai", "Kimi K3.1 Pro"), m("moonshotai", "Kimi K3"), m("opencode", "Big Pickle")]
  assert.deepEqual([...sharedNames(all)], ["kimi k3.1 pro"])
  assert.deepEqual(modelLabel(all[0]!, all), { name: "Kimi K3.1 Pro", provider: "kimi-code-plan-global", tags: "", images: true })
  assert.deepEqual(modelLabel(all[1]!, all), { name: "Kimi K3.1 Pro", provider: "moonshotai", tags: "", images: true })
  assert.equal(labelText(modelLabel(all[2]!, all)), "Kimi K3")
  assert.equal(labelText(modelLabel(all[2]!, all, { provider: "always" })), "Kimi K3 · moonshotai")
  // The same provider twice is not two models: no provider needed.
  assert.equal(sharedNames([m("a", "X"), m("a", "X")]).size, 0)
})

test("labels: free and pre-release from the name or id, in that order; the word Free leaves the name", () => {
  assert.deepEqual(modelTags("Tidepool Alpha Free", "opencode/tidepool-alpha-free"), ["free", "alpha"])
  assert.deepEqual(modelTags("Gemini 3 Pro Preview", "gemini-3-pro-preview"), ["preview"])
  assert.deepEqual(modelTags("Nova", "x/nova-beta2"), ["beta"])
  assert.deepEqual(modelTags("Big Pickle", "opencode/big-pickle", ["free"]), ["free"])
  // A word that only holds one of these is not one.
  assert.deepEqual(modelTags("Freeform Coder", "x/alphabet-7b"), [])
  assert.deepEqual(modelTags("Opus 5.5", "opus"), [])
  assert.equal(plainName("Tidepool Alpha Free", ["free", "alpha"]), "Tidepool Alpha")
  assert.equal(plainName("MiMo-V2.6-Flash Free", ["free"]), "MiMo-V2.6-Flash")
  assert.equal(plainName("Grok Code (free)", ["free"]), "Grok Code")
  assert.equal(plainName("Free", ["free"]), "Free")
  assert.equal(plainName("Opus 5.5", []), "Opus 5.5")
  const tide = m("opencode", "Tidepool Alpha", { images: false, tags: ["free", "alpha"] })
  assert.equal(labelText(modelLabel(tide, [tide])), "Tidepool Alpha · free, alpha · no images")
  assert.equal(labelText(modelLabel(tide, [tide]), { images: false }), "Tidepool Alpha · free, alpha")
})

test("the same model said two ways: Claude's API id and the list's name reduce to the same words", () => {
  assert.equal(modelWords("claude-opus-5-5"), modelWords("Opus 5.5"))
  assert.equal(modelWords("claude-haiku-4-5-20251001"), modelWords("Haiku 4.5"))
  assert.equal(modelWords("moonshotai/kimi-k3.1-pro"), modelWords("Kimi K3.1 Pro"))
  assert.notEqual(modelWords("claude-sonnet-5"), modelWords("Sonnet 5.5"))
})

test("OpenCode 2.x's model API: which take pictures, which are its own free ones, which are pre-releases", () => {
  const facts = parseModelApi(
    JSON.stringify({
      location: { directory: "/home/k" },
      data: [
        { id: "tidepool-alpha-free", providerID: "opencode", name: "Tidepool Alpha Free", capabilities: { input: ["text"] }, cost: [{ input: 0, output: 0 }], status: "active" },
        { id: "hy4-flash-free", providerID: "opencode", capabilities: { input: ["text", "image"] }, cost: [{ input: 0, output: 0 }], status: "beta" },
        { id: "k3.1-pro", providerID: "kimi-code-plan-global", capabilities: { input: ["text", "image", "video"] }, cost: [{ input: 0, output: 0 }] },
        { id: "kimi-k3.1-pro", providerID: "moonshotai", capabilities: { input: ["text", "image"] }, cost: [{ input: 2, output: 10 }] },
        { id: "opus", providerID: "claude-agent", capabilities: { input: ["text", "image", "pdf"] }, cost: [] },
        { providerID: "nameless" },
      ],
    }),
  )
  assert.deepEqual(Object.fromEntries(facts!), {
    "opencode/tidepool-alpha-free": { images: false, tags: ["free"] },
    "opencode/hy4-flash-free": { images: true, tags: ["free", "beta"] },
    // A plan paid by the month lists no cost per token: it is not free.
    "kimi-code-plan-global/k3.1-pro": { images: true },
    "moonshotai/kimi-k3.1-pro": { images: true },
    "claude-agent/opus": { images: true },
  })
  assert.equal(parseModelApi("<!doctype html><html>"), undefined)
  assert.equal(parseModelApi(JSON.stringify({ error: "x" })), undefined)
})

test("OpenCode 1.x's verbose model list: each model's line, then its JSON", () => {
  const out = [
    "opencode/grok-code",
    "{",
    '  "id": "grok-code",',
    '  "capabilities": { "input": { "text": true, "image": false } },',
    '  "cost": { "input": 0, "output": 0 },',
    '  "status": "alpha"',
    "}",
    "anthropic/claude-sonnet-4-5",
    "{",
    '  "modalities": { "input": ["text", "image"] },',
    '  "cost": { "input": 3, "output": 15 }',
    "}",
  ].join("\n")
  assert.deepEqual(Object.fromEntries(parseModelsVerbose(out)!), {
    "opencode/grok-code": { images: false, tags: ["free", "alpha"] },
    "anthropic/claude-sonnet-4-5": { images: true },
  })
  assert.equal(parseModelsVerbose("opencode/a\nopencode/b\n"), undefined)
})

test("the agent's own way to add a key: from its sign-in methods, else OpenCode's; none for others", () => {
  const opencode = { agentInfo: { name: "OpenCode", version: "2.3.2" }, authMethods: [{ id: "opencode-login", name: "Login with opencode", description: "Run `opencode auth login` in the terminal" }] }
  assert.equal(addKeyCommand(opencode, ["opencode", "acp"]), "opencode auth login")
  assert.equal(addKeyCommand({ agentInfo: { name: "OpenCode" } }, ["opencode", "acp"]), "opencode auth login")
  assert.equal(addKeyCommand({ authMethods: [{ id: "api-key", description: "Use an API key to authenticate" }] }, ["codex-acp"]), undefined)
  assert.equal(addKeyCommand({}, ["claude-agent-acp"]), undefined)
  assert.equal(isOpenCode({}, ["/home/k/.local/bin/opencode", "acp"]), true)
  assert.equal(isOpenCode({ agentInfo: { name: "@agentclientprotocol/claude-agent-acp" } }, ["npx"]), false)
})

test("a picture the model could not read: OpenCode's words in its place, and the model's own retelling", () => {
  assert.ok(PICTURE_UNREAD.test('ERROR: Cannot read "image-1.jpg" (this model does not support image input). Inform the user.'))
  assert.ok(PICTURE_UNREAD.test("the images attached to this note could not be read by the model (it does not support image input)"))
  assert.ok(!PICTURE_UNREAD.test("I looked at the screenshot: the button is too small."))
  assert.ok(NO_PICTURES.test("Invalid request: The current model does not support image input"))
})
