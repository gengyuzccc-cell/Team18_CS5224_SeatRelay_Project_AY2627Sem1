// Worker-thread bootstrap. Worker threads do not inherit tsx's module hooks from the parent
// process, so this plain-JS entry registers them inside the thread and then loads worker.ts.
import { register } from 'tsx/esm/api';

const unregister = register();
await import('./worker.ts');
await unregister();
