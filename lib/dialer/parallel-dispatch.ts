// Await all launches together: one slow provider request must not serialize a batch.
export async function dispatchCommands<Command>(commands: Command[], execute: (command: Command) => Promise<void>) {
  return Promise.allSettled(commands.map(execute));
}
