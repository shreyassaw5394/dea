export const randomBytes = (n) => {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return { toString: (enc) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, enc === "hex" ? n * 2 : n * 2) };
};
export const createHash = () => { throw new Error("hashing not available in the browser stub"); };
export default { randomBytes, createHash };
