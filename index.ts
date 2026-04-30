import { DeepgramAdapter } from './deepgram';
import { GoogleSTTAdapter } from './google';
import { AzureSTTAdapter } from './azure';
import type { STTProvider, STTProviderName } from '../types';

/**
 * Factory that instantiates the correct STT adapter by name.
 * Called by STTRouter.createSession and STTRouterSession.switchProvider.
 */
export function createSTTProvider(name: STTProviderName): STTProvider {
  switch (name) {
    case 'deepgram': return new DeepgramAdapter();
    case 'google':   return new GoogleSTTAdapter();
    case 'azure':    return new AzureSTTAdapter();
    default:
      // Exhaustiveness guard — TypeScript should catch this at compile time
      throw new Error(`Unknown STT provider: "${name as string}"`);
  }
}
