#!/usr/bin/env node

/**
 * Script to unregister ALL openduck:// and goose:// protocol handlers
 * Usage: node scripts/unregister-deeplink-protocols.js
 */

const { execSync } = require('child_process');

const PROTOCOLS = ['openduck', 'goose'];

function unregisterAllProtocolHandlers() {
  console.log('Unregistering ALL openduck:// and goose:// protocol handlers...');

  try {
    console.log('Finding all registered OpenDuck/Goose applications...');
    const dumps = PROTOCOLS.map((protocol) => {
      try {
        return execSync(
          `/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -dump | grep -B 10 -A 10 "claimed schemes:.*${protocol}:"`,
          { encoding: 'utf8' }
        );
      } catch {
        return '';
      }
    });
    const lsregisterOutput = dumps.join('\n');

    const pathMatches = lsregisterOutput.match(/path:\s+(.+\.app)/g);
    const uniquePaths = new Set();

    if (pathMatches) {
      pathMatches.forEach((match) => {
        const appPath = match.replace(/path:\s+/, '').trim();
        if (
          appPath.includes('OpenDuck') ||
          appPath.includes('openduck') ||
          appPath.includes('Goose') ||
          appPath.includes('goose')
        ) {
          uniquePaths.add(appPath);
        }
      });
    }

    console.log(`Found ${uniquePaths.size} OpenDuck/Goose app(s) to unregister:`);
    uniquePaths.forEach((appPath) => console.log(`  - ${appPath}`));

    let unregisteredCount = 0;
    uniquePaths.forEach((appPath) => {
      try {
        console.log(`Unregistering: ${appPath}`);
        execSync(
          `/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -u "${appPath}"`,
          { stdio: 'ignore' }
        );
        unregisteredCount++;
      } catch (error) {
        console.log(`  Warning: Could not unregister ${appPath} (may already be unregistered)`);
      }
    });

    console.log('\nUnregistering by bundle identifier...');
    const bundleIds = [
      'dev.openduck.desktop',
      'com.electron.openduck',
      'com.electron.goose',
      'com.block.goose',
      'com.block.goose.dev',
    ];

    bundleIds.forEach((bundleId) => {
      try {
        console.log(`Unregistering bundle: ${bundleId}`);
        execSync(
          `/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -u "${bundleId}"`,
          { stdio: 'ignore' }
        );
      } catch (error) {
        // Ignore errors for bundle IDs that don't exist
      }
    });

    console.log('Rebuilding Launch Services database...');
    try {
      execSync(
        '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -kill -r -domain local -domain system -domain user',
        { stdio: 'ignore' }
      );
    } catch (error) {
      console.log('Warning: Could not rebuild Launch Services database');
    }

    console.log(`\n✅ Successfully processed ${unregisteredCount} OpenDuck/Goose applications`);
    console.log('All openduck:// and goose:// protocol handlers have been unregistered.');
    console.log('\nNote: You may need to restart your system for changes to take full effect.');
  } catch (error) {
    console.error('Error during unregistration:', error.message);
    console.log('\nManual cleanup options:');
    console.log('1. Use Activity Monitor to quit all OpenDuck processes');
    console.log('2. Delete OpenDuck apps from Applications folder');
    console.log(
      '3. Run: sudo /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -kill -r -domain local -domain system -domain user'
    );
  }
}

unregisterAllProtocolHandlers();
