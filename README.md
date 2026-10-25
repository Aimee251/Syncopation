# Syncopation

1. sox is not installed (Fatal Exit)


stt.ts
 uses the sox command-line utility to record audio from your microphone. Because sox is not found, the script throws an error and exits immediately.

Fix: Install sox via Homebrew:

bash
brew install sox


