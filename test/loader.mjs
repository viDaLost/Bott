const MOCKS = {
  sdk: new URL('./mocks/sdk.js', import.meta.url).href,
  'sdk/db': new URL('./mocks/sdk-db.js', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  if (MOCKS[specifier]) return { url: MOCKS[specifier], shortCircuit: true };
  return next(specifier, context);
}
