#!/usr/bin/env node
import { Command } from 'commander';
import { adminDoctor } from './commands/admin-doctor.js';

const program = new Command();
program.name('brain').description('Personal Brain command line');

const admin = program.command('admin').description('administrative commands');

admin
  .command('doctor')
  .description('check that the brain is reachable and healthy')
  .option('--json', 'print the machine-readable response envelope')
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await adminDoctor({ json: options.json === true });
  });

await program.parseAsync(process.argv);
