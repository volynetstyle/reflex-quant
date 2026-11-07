// Which build of quant the suite runs against (vitest.config.ts): the
// development build by default, the production build under
// `npm run test:production`. Tests of a precondition's diagnosis (C1) run
// only against the development build; every other test runs against both.
export const dev = process.env.QUANT_DEV !== "0";
