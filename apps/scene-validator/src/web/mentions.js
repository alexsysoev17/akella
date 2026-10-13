// Textarea remains the native editor (IME, clipboard and browser undo).
export function reconcileMentions(before, after, mentions, edit) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = before.length,
    nextEnd = after.length;
  while (
    end > start &&
    nextEnd > start &&
    before[end - 1] === after[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }
  if (
    edit &&
    after.startsWith(before.slice(0, edit.start)) &&
    after.endsWith(before.slice(edit.end))
  ) {
    start = edit.start;
    end = edit.end;
    nextEnd = after.length - (before.length - end);
  }
  const delta = nextEnd - end;
  return mentions
    .flatMap((m) => {
      if (m.end <= start) return [{ ...m }];
      if (m.start >= end)
        return [{ ...m, start: m.start + delta, end: m.end + delta }];
      return [];
    })
    .filter((m) => after.slice(m.start, m.end) === m.displayName);
}

export function attachMentions(input) {
  let text = input.value,
    mentions = [],
    suggestion,
    composing = false;
  const snapshots = [{ text, mentions: [] }];
  let cursor = 0,
    pendingEdit;
  const overlay = document.createElement("div");
  overlay.className = "prompt-ghost";
  overlay.setAttribute("aria-hidden", "true");
  input.parentElement.append(overlay);
  const abort = new AbortController(),
    options = { signal: abort.signal };
  function paint() {
    overlay.replaceChildren();
    overlay.hidden = !suggestion;
    input.classList.toggle("has-ghost", !!suggestion);
    if (!suggestion) return;
    const style = getComputedStyle(input);
    for (const key of [
      "font",
      "letterSpacing",
      "padding",
      "boxSizing",
      "lineHeight",
      "wordSpacing",
      "textIndent",
      "tabSize",
    ])
      overlay.style[key] = style[key];
    overlay.style.width = input.offsetWidth + "px";
    overlay.style.height = input.offsetHeight + "px";
    overlay.style.left = input.offsetLeft + "px";
    overlay.style.top = input.offsetTop + "px";
    const before = document.createElement("span"),
      ghost = document.createElement("span"),
      after = document.createElement("span");
    before.textContent = input.value.slice(0, suggestion.at);
    ghost.textContent = suggestion.displayName;
    ghost.className = "ghost-name";
    after.textContent = input.value.slice(suggestion.at);
    overlay.append(before, ghost, after);
    overlay.scrollTop = input.scrollTop;
    overlay.scrollLeft = input.scrollLeft;
  }
  function save() {
    snapshots.splice(cursor + 1);
    snapshots.push({ text, mentions: structuredClone(mentions) });
    if (snapshots.length > 100) snapshots.shift();
    cursor = snapshots.length - 1;
  }
  const resize = new ResizeObserver(paint);
  resize.observe(input);
  input.addEventListener(
    "beforeinput",
    (event) => {
      let start = input.selectionStart,
        end = input.selectionEnd;
      if (event.inputType === "deleteContentBackward" && start === end)
        start = Math.max(0, start - 1);
      if (event.inputType === "deleteContentForward" && start === end)
        end = Math.min(input.value.length, end + 1);
      pendingEdit = /^(insert|deleteContent)/.test(event.inputType)
        ? { start, end }
        : undefined;
    },
    options,
  );
  input.addEventListener(
    "input",
    (event) => {
      const next = input.value;
      const direction =
        event.inputType === "historyUndo"
          ? -1
          : event.inputType === "historyRedo"
            ? 1
            : 0;
      let found = -1;
      if (direction)
        for (
          let i = cursor + direction;
          i >= 0 && i < snapshots.length;
          i += direction
        ) {
          if (snapshots[i].text === next) {
            found = i;
            break;
          }
        }
      mentions =
        found >= 0
          ? structuredClone(snapshots[found].mentions)
          : reconcileMentions(text, next, mentions, pendingEdit);
      pendingEdit = undefined;
      text = next;
      if (found >= 0) cursor = found;
      else save();
      suggestion = undefined;
      paint();
    },
    options,
  );
  input.addEventListener(
    "compositionstart",
    () => {
      composing = true;
      suggestion = undefined;
      paint();
    },
    options,
  );
  input.addEventListener(
    "compositionend",
    () => {
      composing = false;
    },
    options,
  );
  input.addEventListener("scroll", paint, options);
  input.addEventListener(
    "pointerdown",
    () => {
      suggestion = undefined;
      paint();
    },
    options,
  );
  input.addEventListener(
    "keydown",
    (event) => {
      if (
        !suggestion ||
        composing ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        suggestion = undefined;
        paint();
        return;
      }
      if (
        event.key === " " &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        const accepted = suggestion,
          at = accepted.at;
        suggestion = undefined;
        paint();
        // insertText integrates with native textarea undo. Never replace selected user text.
        input.setSelectionRange(at, at);
        const inserted = accepted.displayName + " ";
        if (!document.execCommand("insertText", false, inserted)) {
          input.setRangeText(inserted, at, at, "end");
          input.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: inserted,
            }),
          );
        }
        mentions.push({
          ...accepted,
          start: at,
          end: at + accepted.displayName.length,
        });
        delete mentions[mentions.length - 1].at;
        snapshots[cursor] = {
          text: input.value,
          mentions: structuredClone(mentions),
        };
        return;
      }
      if (
        event.key !== "Shift" &&
        event.key !== "Control" &&
        event.key !== "Meta"
      ) {
        suggestion = undefined;
        paint();
      }
    },
    options,
  );
  return {
    suggest(object) {
      if (composing || !object.logicalObjectId) return;
      suggestion = {
        displayName: object.name || object.type,
        logicalObjectId: object.logicalObjectId,
        sceneId: object.sceneId,
        sourceNodeId: object.targetId,
        at: input.selectionStart,
      };
      input.focus({ preventScroll: true });
      paint();
    },
    references() {
      // Programmatic edits must not accidentally reuse references.
      if (input.value !== text) {
        mentions = reconcileMentions(text, input.value, mentions);
        text = input.value;
      }
      return structuredClone(mentions);
    },
    destroy() {
      abort.abort();
      resize.disconnect();
      overlay.remove();
      input.classList.remove("has-ghost");
    },
  };
}
