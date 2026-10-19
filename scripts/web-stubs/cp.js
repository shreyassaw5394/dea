export const spawn = () => { throw new Error("subprocesses are not available in the browser"); };
export const execFile = spawn, exec = spawn, execSync = spawn, spawnSync = spawn;
export default { spawn, execFile, exec, execSync, spawnSync };
