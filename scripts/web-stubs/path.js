export const join = (...p) => p.filter(Boolean).join("/");
export const basename = (p) => String(p).split("/").pop() ?? "";
export const dirname = (p) => String(p).split("/").slice(0, -1).join("/") || ".";
export const resolve = (...p) => p.filter(Boolean).join("/");
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; };
export default { join, basename, dirname, resolve, extname };
