// CodeMirror 6, loaded only when a reader clicks "Edit". It must look like the static Shiki block
// it replaces: same padding, font, background and the github-light / github-dark token colours.
// Tokens get sh-* classes here; styles.css colours them with the Shiki palette per scheme.
import { EditorView, minimalSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { LanguageSupport } from "@codemirror/language";
import { syntaxHighlighting } from "@codemirror/language";
import { styleTags, tagHighlighter, tags as t } from "@lezer/highlight";

// Shiki colours imported names as plain variables, not as definitions.
const js = new LanguageSupport(javascriptLanguage.configure({ props: [styleTags({ "ImportGroup/VariableDefinition": t.variableName })] }));

const shiki = tagHighlighter([
  { tag: [t.keyword, t.operator, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], class: "sh-kw" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.typeName], class: "sh-fn" },
  { tag: [t.number, t.bool, t.null, t.atom, t.definition(t.variableName), t.propertyName, t.constant(t.variableName)], class: "sh-const" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "sh-str" },
  { tag: [t.local(t.variableName), t.definition(t.local(t.variableName))], class: "sh-param" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "sh-cmt" },
]);

export function mount(parent: HTMLElement, doc: string, onRun: () => void): EditorView {
  return new EditorView({
    doc,
    parent,
    extensions: [
      minimalSetup,
      js,
      syntaxHighlighting(shiki),
      keymap.of([{ key: "Mod-Enter", run: () => (onRun(), true) }, indentWithTab]),
      EditorView.contentAttributes.of({ "aria-label": "Code editor. Ctrl+Enter or Cmd+Enter runs it." }),
    ],
  });
}
