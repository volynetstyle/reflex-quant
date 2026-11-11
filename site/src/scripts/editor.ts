// CodeMirror 6, loaded only when a reader clicks "Edit". Token colours come from CSS (tok-* classes),
// so light and dark mode follow the site's prefers-color-scheme without a second theme bundle.
import { EditorView, minimalSetup } from "codemirror";
import { keymap, lineNumbers } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";

export function mount(parent: HTMLElement, doc: string, onRun: () => void): EditorView {
  return new EditorView({
    doc,
    parent,
    extensions: [
      minimalSetup,
      lineNumbers(),
      javascript(),
      syntaxHighlighting(classHighlighter),
      keymap.of([{ key: "Mod-Enter", run: () => (onRun(), true) }, indentWithTab]),
      EditorView.contentAttributes.of({ "aria-label": "Code editor. Ctrl+Enter or Cmd+Enter runs it." }),
    ],
  });
}
