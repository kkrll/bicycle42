// The app's three sounds. cues.ts says when; this plays them, unless sounds are switched off.
import { createSignal } from "solid-js"
import type { Bridge } from "../shared/types"
import { chatCue, cueFor, hear, type Cue, type Heard } from "./cues"
import { recall, remember, state } from "./store"
import ascend from "./sounds/ascend.m4a"
import descend from "./sounds/descend.m4a"
import staccato from "./sounds/f-staccato.m4a"

const FILES: Record<Cue, string> = { question: ascend, negative: descend, routine: staccato }

/** The recordings peak above full scale; this leaves them room and keeps them in the background. */
const VOLUME = 0.6
/** The same cue is not started again this soon: three notes failing together are one sound. */
const GAP = 1000
/** "Finished" waits this long for the news that it failed or was stopped, which can come second. */
const SETTLE = 400
/** After a failure or a stop, the rest that follows is not announced. */
const QUIET = 1500

export const [soundOn, setSoundOn] = createSignal(recall("sound") !== "0")

const players = new Map<Cue, HTMLAudioElement>()
const last = new Map<Cue, number>()
let pending: ReturnType<typeof setTimeout> | undefined
let quietUntil = 0

function play(cue: Cue): void {
  if (!soundOn()) return
  const now = Date.now()
  if (now - (last.get(cue) ?? 0) < GAP) return
  last.set(cue, now)
  let player = players.get(cue)
  if (!player) {
    player = new Audio(FILES[cue])
    player.volume = VOLUME
    players.set(cue, player)
  }
  player.currentTime = 0
  // No output device, or a file that would not load: the app works without its sounds.
  player.play().catch(() => {})
}

function hush(): void {
  clearTimeout(pending)
  pending = undefined
  quietUntil = Date.now() + QUIET
}

function cue(what: Cue | "hush" | null): void {
  if (!what) return
  if (what === "hush") return hush()
  if (what !== "routine") {
    hush()
    return play(what)
  }
  if (Date.now() < quietUntil) return
  pending ??= setTimeout(() => {
    pending = undefined
    play("routine")
  }, SETTLE)
}

/** Sounds on or off, remembered. Switched on, the routine one plays: that is how they sound. */
export function toggleSound(): void {
  setSoundOn(!soundOn())
  remember("sound", soundOn() ? "1" : "0")
  if (soundOn()) play("routine")
}

/** Listens to what main sends. Call after the store's start(), so `state` is already up to date. */
export function listen(bridge: Bridge): void {
  let heard: Heard | undefined
  bridge.onState((next) => {
    const now = hear(next, heard)
    cue(cueFor(heard, now))
    heard = now
  })
  bridge.onChat((e) => e.session === (state.session?.id ?? "") && cue(chatCue(e)))
}
