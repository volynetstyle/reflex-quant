import { BASE, SITE, UPDATED } from "./config.mjs";

export { UPDATED };
export const ORIGIN = SITE + BASE;
export const REPO = "https://github.com/volynetstyle/reflex-quant";
export const BLOB = `${REPO}/blob/main`;
export const NPM = "https://www.npmjs.com/package/reflex-quant";
export const AUTHOR = { "@type": "Person", name: "Andrii Volynets", url: "https://github.com/volynetstyle" };

/** Site path ("/benchmarks/") -> root-relative href under the base ("/reflex-quant/benchmarks/"). */
export const href = (path: string) => BASE + path;
/** Site path -> absolute URL, for canonical, Open Graph and JSON-LD. */
export const abs = (path: string) => ORIGIN + path;

export const NAV: [string, string][] = [
  ["/", "Reflex Quant"],
  ["/javascript-signals-runtime/", "Signals runtime"],
  ["/dynamic-dependency-tracking/", "Dependency tracking"],
  ["/benchmarks/", "Benchmarks"],
  ["/alien-signals-comparison/", "vs alien-signals"],
  ["/vue-reactivity-comparison/", "vs Vue reactivity"],
];

export const SOFTWARE = {
  "@type": "SoftwareSourceCode",
  "@id": `${ORIGIN}/#software`,
  name: "Reflex Quant",
  alternateName: "reflex-quant",
  description:
    "A 2.2 KB JavaScript signals runtime: signals, computeds and effects with exact dynamic dependency tracking, glitch-free propagation and no recursion.",
  codeRepository: REPO,
  programmingLanguage: ["TypeScript", "JavaScript"],
  runtimePlatform: "JavaScript",
  license: "https://opensource.org/licenses/MIT",
  author: AUTHOR,
  sameAs: [REPO, NPM],
  keywords: "javascript signals, fine-grained reactivity, reactive programming, computed, effect, dependency tracking",
};

export const EXAMPLE = [
  'import { computed, effect, get, set, signal } from "reflex-quant";',
  "",
  "const full = signal(false);",
  'const first = signal("Ada");',
  'const last = signal("Lovelace");',
  "const name = computed(() => (get(full) ? `${get(first)} ${get(last)}` : get(first)));",
  "",
  'effect(() => console.log(get(name))); // "Ada"        name reads full, first',
  'set(last, "Byron");                   // nothing runs: last was not read',
  'set(full, true);                      // "Ada Byron"  name now reads last too',
  'set(full, false);                     // "Ada"        last is dropped again',
  'set(last, "King");                    // nothing runs',
].join("\n");

export type Faq = [question: string, answer: string][];
