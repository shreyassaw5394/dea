const no = () => { throw new Error("fs is not available in the browser"); };
export const createWriteStream = no, readFileSync = no, writeFileSync = no, existsSync = () => false;
export default { createWriteStream: no, readFileSync: no, existsSync: () => false };
