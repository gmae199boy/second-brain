import type { Connector } from 'second_brain';
import { harnesses } from '../harnesses.js';

export function connectors(env: NodeJS.ProcessEnv): readonly Connector[] {
  return harnesses.map((harness) => harness.connector(env));
}
