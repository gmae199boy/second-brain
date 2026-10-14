import type { Connector } from 'second_brain';

/**
 * The connector registry: every harness this build can connect to. It is the
 * one list the installer offers and the one list `brain setup connect` accepts,
 * so a harness nobody registered cannot be half-connected by a typo.
 *
 * It is deliberately empty. The Claude Code connector — the parser, the hook
 * contents, the settings file it writes — is epic 2; until then the installer
 * says there is no harness to connect and carries on, which is a complete
 * install for a brain nothing writes into yet.
 *
 * ```ts
 * export const connectors: readonly Connector[] = [claudeCodeConnector()];
 * ```
 */
export const connectors: readonly Connector[] = [];
