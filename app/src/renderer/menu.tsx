// The list that opens above the message box for `/` and `@`. It never takes the focus: the
// textarea keeps it and drives the list with the arrow keys (aria-activedescendant), so typing
// goes on filtering while the list is open. The pointer can pick too; pressing on the list does
// not move the focus either.
import { For, Show, createEffect } from "solid-js"
import { Icon, type IconName } from "./icons"

export type MenuItem = {
  key: string
  label: string
  detail?: string
  icon?: IconName
  /** The detail is a path: shorten it from the start, not the end. */
  path?: boolean
  /** Items are grouped by this, in the order the groups first appear. */
  group?: string
}

export function SuggestMenu(props: {
  id: string
  label: string
  items: MenuItem[]
  active: number
  /** Shown instead of the items when there are none. */
  empty: string
  onActive: (index: number) => void
  onPick: (index: number) => void
}) {
  let list!: HTMLDivElement
  // Keep the active row in view while the arrows walk past the edge of the list.
  createEffect(() => {
    const el = list.querySelector<HTMLElement>(`#${props.id}-${props.active}`)
    el?.scrollIntoView({ block: "nearest" })
  })
  return (
    <div
      class="suggest"
      id={props.id}
      role="listbox"
      aria-label={props.label}
      ref={list}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Show when={props.items.length} fallback={<p class="suggest-empty">{props.empty}</p>}>
        <For each={props.items}>
          {(item, i) => (
            <>
              <Show when={item.group && item.group !== props.items[i() - 1]?.group}>
                <p class="suggest-group" role="presentation">
                  {item.group}
                </p>
              </Show>
              <div
                class="suggest-item"
                id={`${props.id}-${i()}`}
                role="option"
                aria-selected={i() === props.active}
                onMouseMove={() => i() !== props.active && props.onActive(i())}
                onClick={() => props.onPick(i())}
              >
                <Show when={item.icon}>{(name) => <Icon name={name()} />}</Show>
                <span class="suggest-label">{item.label}</span>
                <Show when={item.detail}>
                  <span class="suggest-detail" classList={{ "cut-start": item.path }} title={item.detail}>
                    {/* Marks keep a right-to-left box from moving the slashes of a path. */}
                    {item.path ? `\u200e${item.detail}\u200e` : item.detail}
                  </span>
                </Show>
              </div>
            </>
          )}
        </For>
      </Show>
    </div>
  )
}
