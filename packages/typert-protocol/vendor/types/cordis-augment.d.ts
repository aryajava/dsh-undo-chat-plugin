import type { RemoteInvocation, TypertRegistryContract } from './types.js';

declare module '@deepseek-ai/cordis' {
    interface Context {
        typert: TypertRegistryContract;
        /**
         * The Remote call this Context was derived for, or `undefined` on a
         * Context no Remote call derived. A Service method reads it as
         * `this.ctx.invocation`.
         */
        readonly invocation: RemoteInvocation | undefined;
    }
}
