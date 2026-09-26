import type { PermissionRule } from './rules.schema.js';

/**
 * Non-overridable root/system destruction rules.
 * These are evaluated before every user and configurable rule.
 */
export const HARD_DENY_RULES: readonly PermissionRule[] = [
  {
    id: 'hard-deny-rm-root',
    pattern: 'rm -rf /',
    decision: 'deny',
    tier: 1,
    description: 'Recursive deletion of the filesystem root.',
  },
  {
    id: 'hard-deny-rm-root-glob',
    pattern: 'rm -rf /*',
    decision: 'deny',
    tier: 1,
    description: 'Recursive deletion of filesystem root paths.',
  },
  {
    id: 'hard-deny-rm-home-root',
    pattern: 'rm -rf ~',
    decision: 'deny',
    tier: 1,
    description: 'Recursive deletion of the home directory.',
  },
  {
    id: 'hard-deny-rm-home-glob',
    pattern: 'rm -rf ~/*',
    decision: 'deny',
    tier: 1,
    description: 'Recursive deletion of home directory contents.',
  },
  {
    id: 'hard-deny-rm-home-deep',
    pattern: 'rm -rf ~/**',
    decision: 'deny',
    tier: 1,
    description: 'Recursive deletion of home directory contents.',
  },
  {
    id: 'hard-deny-rm-root-anywhere',
    pattern: '**rm -rf /*',
    decision: 'deny',
    tier: 1,
    description: 'Recursive root deletion hidden in a compound command.',
  },
  {
    id: 'hard-deny-rm-home-anywhere',
    pattern: '**rm -rf ~*',
    decision: 'deny',
    tier: 1,
    description: 'Recursive home deletion hidden in a compound command.',
  },
  {
    id: 'hard-deny-rm-home-anywhere-deep',
    pattern: '**rm -rf ~/**',
    decision: 'deny',
    tier: 1,
    description: 'Recursive home deletion hidden in a compound command.',
  },
  {
    id: 'hard-deny-dd-block-device',
    pattern: '**of=/dev/sd*',
    decision: 'deny',
    tier: 1,
    description: 'Writing directly to a raw storage device.',
  },
  {
    id: 'hard-deny-dd-nvme-device',
    pattern: '**of=/dev/nvme*',
    decision: 'deny',
    tier: 1,
    description: 'Writing directly to an NVMe storage device.',
  },
  {
    id: 'hard-deny-dd-hd-device',
    pattern: '**of=/dev/hd*',
    decision: 'deny',
    tier: 1,
    description: 'Writing directly to an IDE storage device.',
  },
  {
    id: 'hard-deny-dd-vd-device',
    pattern: '**of=/dev/vd*',
    decision: 'deny',
    tier: 1,
    description: 'Writing directly to a virtual storage device.',
  },
  {
    id: 'hard-deny-mkfs-device',
    pattern: '**mkfs*/dev/*',
    decision: 'deny',
    tier: 1,
    description: 'Formatting a device or mounted filesystem.',
  },
  {
    id: 'hard-deny-sudoers-write',
    pattern: '**/etc/sudoers',
    decision: 'deny',
    tier: 1,
    description: 'Direct writes to the system sudoers file.',
  },
  {
    id: 'hard-deny-sudoers-directory-write',
    pattern: '**/etc/sudoers.d/*',
    decision: 'deny',
    tier: 1,
    description: 'Direct writes to the system sudoers directory.',
  },
  {
    id: 'hard-deny-firewall-stop',
    pattern: '**systemctl stop firewalld*',
    decision: 'deny',
    tier: 1,
    description: 'Disabling the host firewall.',
  },
  {
    id: 'hard-deny-firewall-panic',
    pattern: '**firewall-cmd*--panic-mode*',
    decision: 'deny',
    tier: 1,
    description: 'Putting the firewall into panic mode.',
  },
  {
    id: 'hard-deny-selinux-disable',
    pattern: '**setenforce 0*',
    decision: 'deny',
    tier: 1,
    description: 'Disabling SELinux enforcement.',
  },
];

/** Built-in ask/informational rules layered with user additions. */
export const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = [
  {
    id: 'ask-dnf-remove',
    pattern: 'dnf remove **',
    decision: 'ask',
    tier: 2,
    description: 'Removing installed packages changes system state.',
  },
  {
    id: 'ask-dnf-autoremove',
    pattern: 'dnf autoremove **',
    decision: 'ask',
    tier: 2,
    description: 'Autoremoving packages changes system state.',
  },
  {
    id: 'ask-firewall-change',
    pattern: '**firewall-cmd **',
    decision: 'ask',
    tier: 2,
    description: 'Changing firewall rules requires confirmation.',
  },
  {
    id: 'ask-firewall-iptables',
    pattern: '**iptables **',
    decision: 'ask',
    tier: 2,
    description: 'Changing packet filtering rules requires confirmation.',
  },
  {
    id: 'ask-chmod-system',
    pattern: 'chmod /**',
    decision: 'ask',
    tier: 2,
    description: 'Changing permissions on system paths requires confirmation.',
  },
  {
    id: 'ask-chmod-system-with-flags',
    pattern: 'chmod ** /**',
    decision: 'ask',
    tier: 2,
    description: 'Changing permissions on system paths requires confirmation.',
  },
  {
    id: 'ask-chown-system',
    pattern: 'chown /**',
    decision: 'ask',
    tier: 2,
    description: 'Changing ownership on system paths requires confirmation.',
  },
  {
    id: 'ask-chown-system-with-flags',
    pattern: 'chown ** /**',
    decision: 'ask',
    tier: 2,
    description: 'Changing ownership on system paths requires confirmation.',
  },
  {
    id: 'ask-read-private-key',
    pattern: '** id_rsa*',
    decision: 'ask',
    tier: 2,
    description:
      'Reading a private key would send it to the model provider. Confirm you want that.',
  },
  {
    id: 'ask-read-private-key-ed25519',
    pattern: '** id_ed25519*',
    decision: 'ask',
    tier: 2,
    description:
      'Reading a private key would send it to the model provider. Confirm you want that.',
  },
  {
    id: 'ask-read-ssh-directory',
    pattern: '** .ssh/**',
    decision: 'ask',
    tier: 2,
    description:
      'Reading SSH material would send it to the model provider. Confirm you want that.',
  },
  {
    id: 'ask-read-aws-credentials',
    pattern: '** .aws/credentials*',
    decision: 'ask',
    tier: 2,
    description:
      'Reading cloud credentials would send them to the model provider. Confirm you want that.',
  },
  {
    id: 'ask-read-shadow',
    pattern: '** /etc/shadow*',
    decision: 'ask',
    tier: 2,
    description:
      'Reading the password database requires root and is highly sensitive.',
  },
  {
    id: 'ask-read-pem',
    pattern: '** *.pem',
    decision: 'ask',
    tier: 2,
    description:
      'Reading a .pem file likely sends a private key or certificate to the model provider.',
  },
  {
    id: 'ask-read-env-file',
    pattern: '** .env',
    decision: 'ask',
    tier: 2,
    description:
      'Reading a .env file usually exposes API keys and secrets to the model provider.',
  },
  {
    id: 'ask-read-env-file-variant',
    pattern: '** .env.*',
    decision: 'ask',
    tier: 2,
    description:
      'Reading a .env file usually exposes API keys and secrets to the model provider.',
  },
  {
    id: 'ask-read-netrc',
    pattern: '** .netrc',
    decision: 'ask',
    tier: 2,
    description:
      'Reading .netrc exposes saved credentials to the model provider.',
  },
  {
    id: 'ask-find-write-output',
    pattern: 'find ** -fprintf **',
    decision: 'ask',
    tier: 2,
    description:
      'find -fprintf writes matched paths into a file. Confirm the destination.',
  },
  {
    id: 'ask-find-write-fprint',
    pattern: 'find ** -fprint **',
    decision: 'ask',
    tier: 2,
    description:
      'find -fprint writes matched paths into a file. Confirm the destination.',
  },
  {
    id: 'ask-find-write-fprint0',
    pattern: 'find ** -fprint0 **',
    decision: 'ask',
    tier: 2,
    description:
      'find -fprint0 writes matched paths into a file. Confirm the destination.',
  },
  {
    id: 'ask-find-write-fls',
    pattern: 'find ** -fls **',
    decision: 'ask',
    tier: 2,
    description:
      'find -fls appends file listings to a file. Confirm the destination.',
  },
  {
    id: 'ask-find-write-fopen',
    pattern: 'find ** -fopen **',
    decision: 'ask',
    tier: 2,
    description:
      'find -fopen writes every matched path to a file descriptor. Confirm it is intended.',
  },
  {
    id: 'ask-find-delete-action',
    pattern: 'find ** -delete',
    decision: 'ask',
    tier: 2,
    description:
      'find -delete removes every match. Confirm the search root is safe.',
  },
  {
    id: 'ask-copy-files',
    pattern: 'cp **',
    decision: 'ask',
    tier: 2,
    description:
      'Copying files writes to disk and can duplicate secrets. Confirm the source and destination.',
  },
  {
    id: 'ask-create-directory',
    pattern: 'mkdir **',
    decision: 'ask',
    tier: 2,
    description: 'Creating a directory changes the filesystem.',
  },
  {
    id: 'ask-create-file',
    pattern: 'touch **',
    decision: 'ask',
    tier: 2,
    description: 'Creating or touching a file changes the filesystem.',
  },
  {
    id: 'ask-permission-change',
    pattern: 'chmod **',
    decision: 'ask',
    tier: 2,
    description:
      'Changing file permissions can make a file private or world-writable.',
  },
  {
    id: 'ask-ownership-change',
    pattern: 'chown **',
    decision: 'ask',
    tier: 2,
    description: 'Changing file ownership changes who can access a file.',
  },
  {
    id: 'ask-sort-in-place',
    pattern: 'sort -o **',
    decision: 'ask',
    tier: 2,
    description: 'sort -o overwrites a file in place.',
  },
  {
    id: 'ask-service-control',
    pattern: 'systemctl **',
    decision: 'ask',
    tier: 2,
    description:
      'Controlling a system service can stop or reconfigure running software.',
  },
  {
    id: 'ask-package-script',
    pattern: 'npm **',
    decision: 'ask',
    tier: 2,
    description:
      'npm runs scripts and lifecycle hooks from this repository, which executes arbitrary code.',
  },
  {
    id: 'ask-build-tool',
    pattern: 'make **',
    decision: 'ask',
    tier: 2,
    description: 'make executes commands from a Makefile in this repository.',
  },
  {
    id: 'ask-test-runner',
    pattern: 'vitest **',
    decision: 'ask',
    tier: 2,
    description:
      'Running the test suite executes test code from this repository.',
  },
  {
    id: 'ask-compiler',
    pattern: 'tsc **',
    decision: 'ask',
    tier: 2,
    description:
      'Running the compiler can execute plugins configured by this repository.',
  },
  {
    id: 'ask-git-network',
    pattern: 'git push **',
    decision: 'ask',
    tier: 2,
    description: 'Pushing publishes commits to a remote.',
  },
  {
    id: 'ask-git-fetch',
    pattern: 'git fetch **',
    decision: 'ask',
    tier: 2,
    description: 'Fetching contacts a remote and can run remote helpers.',
  },
  {
    id: 'ask-git-commit',
    pattern: 'git commit **',
    decision: 'ask',
    tier: 2,
    description:
      'Committing runs repository hooks, which can execute arbitrary code.',
  },
  {
    id: 'ask-git-force-push',
    pattern: 'git push **--force**',
    decision: 'ask',
    tier: 2,
    description: 'Force-pushing rewrites remote history.',
  },
  {
    id: 'ask-git-reset-hard',
    pattern: 'git reset --hard **',
    decision: 'ask',
    tier: 2,
    description: 'Resetting hard discards local changes.',
  },
  {
    id: 'ask-systemctl-stop',
    pattern: 'systemctl stop **',
    decision: 'ask',
    tier: 2,
    description: 'Stopping system services affects the host.',
  },
  {
    id: 'ask-systemctl-disable',
    pattern: 'systemctl disable **',
    decision: 'ask',
    tier: 2,
    description: 'Disabling system services affects the host.',
  },
  {
    id: 'ask-rm-force-recursive',
    pattern: 'rm -rf **',
    decision: 'ask',
    tier: 2,
    description: 'Recursive force deletion can destroy data.',
  },
  {
    id: 'ask-rm-force-recursive-alt',
    pattern: 'rm -fr **',
    decision: 'ask',
    tier: 2,
    description: 'Recursive force deletion can destroy data.',
  },
  {
    id: 'info-rm-many',
    pattern: 'rm **',
    decision: 'allow',
    tier: 3,
    description: 'Deleting files may affect a large group of files.',
  },
  {
    id: 'info-mv-many',
    pattern: 'mv **',
    decision: 'allow',
    tier: 3,
    description: 'Moving files may affect a large group of files.',
  },
  {
    id: 'info-find-delete',
    pattern: 'find ** -delete',
    decision: 'allow',
    tier: 3,
    description: 'Bulk find deletion may affect many files.',
  },
  {
    id: 'info-tee-overwrite',
    pattern: '**tee **',
    decision: 'allow',
    tier: 3,
    description: 'Writing through tee may overwrite an existing file.',
  },
  {
    id: 'info-shell-redirect',
    pattern: '* > **',
    decision: 'allow',
    tier: 3,
    description: 'Shell redirection may overwrite an existing file.',
  },
];
