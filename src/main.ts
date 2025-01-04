import { PluginDataIO } from 'plugin/data';
import { Reminder, Reminders } from 'model/reminder';
import { DATE_TIME_FORMATTER } from 'model/time';
import { App, Plugin, PluginManifest } from 'obsidian';
import { monkeyPatchConsole } from 'plugin/obsidian-hack/obsidian-debug-mobile';
import { SETTINGS } from 'plugin/settings';
import { registerCommands } from 'plugin/commands';
import { ReminderPluginUI } from 'plugin/ui';
import { ReminderPluginFileSystem } from 'plugin/vault';

export default class ReminderPlugin extends Plugin {
  _pluginDataIO: PluginDataIO;
  private _ui: ReminderPluginUI;
  private _reminders: Reminders;
  private _fileSystem: ReminderPluginFileSystem;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
    this._reminders = new Reminders(() => {
      // on changed
      if (this.ui) {
        this.ui.invalidate();
      }
      this.pluginDataIO.changed = true;
    });
    this._pluginDataIO = new PluginDataIO(this, this.reminders);
    this.reminders.reminderTime = SETTINGS.reminderTime;
    DATE_TIME_FORMATTER.setTimeFormat(SETTINGS.dateFormat, SETTINGS.dateTimeFormat, SETTINGS.strictDateFormat);

    this._ui = new ReminderPluginUI(this);
    this._fileSystem = new ReminderPluginFileSystem(app.vault, this.reminders, () => {
      this.ui.reload(true);
    });
  }

  override async onload() {
    this.ui.onload();
    registerCommands(this);
    this.app.workspace.onLayoutReady(async () => {
      await this.pluginDataIO.load();
      if (this.pluginDataIO.debug.value) {
        monkeyPatchConsole(this);
      }
      this.fileSystem.onload(this);
      this.startPeriodicTask();
    });
  }

  private startPeriodicTask() {
    let intervalTaskRunning = true;
    // Force the view to refresh as soon as possible.
    this.periodicTask().finally(() => {
      intervalTaskRunning = false;
    });

    // Set up the recurring check for reminders.
    this.registerInterval(
      window.setInterval(() => {
        if (intervalTaskRunning) {
          console.log('Skip reminder interval task because task is already running.');
          return;
        }
        intervalTaskRunning = true;
        this.periodicTask().finally(() => {
          intervalTaskRunning = false;
        });
      }, SETTINGS.reminderCheckIntervalSec.value * 1000),
    );
  }

  private async periodicTask(): Promise<void> {
    this.ui.reload(false);

    if (!this.pluginDataIO.scanned.value) {
      this.fileSystem.reloadRemindersInAllFiles().then(() => {
        this.pluginDataIO.scanned.value = true;
        this.pluginDataIO.save();
      });
    }

    this.pluginDataIO.save(false);

    if (this.ui.isEditing()) {
      return;
    }
    const expired = this.reminders.getExpiredReminders(SETTINGS.reminderTime.value);

    let previousReminder: Reminder | undefined = undefined;
    for (const reminder of expired) {
      if (this.app.workspace.layoutReady) {
        if (reminder.muteNotification) {
          // We don't want to set `previousReminder` in this case as the current
          // reminder won't be shown.
          continue;
        }
        if (previousReminder) {
          while (previousReminder.beingDisplayed) {
            // Displaying too many reminders at once can cause crashes on
            // mobile. We use `beingDisplayed` to wait for the current modal to
            // be dismissed before displaying the next.
            await this.sleep(100);
          }
        }
        this.ui.showReminder(reminder);
        previousReminder = reminder;
      }
    }
  }

  /* An asynchronous sleep function. To use it you must `await` as it hands
   * off control to other portions of the JS control loop whilst waiting.
   *
   * @param milliseconds - The number of milliseconds to wait before resuming.
   */
  private async sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  override onunload(): void {
    this.ui.onunload();
  }

  get reminders() {
    return this._reminders;
  }

  get ui() {
    return this._ui;
  }

  get fileSystem() {
    return this._fileSystem;
  }

  get pluginDataIO() {
    return this._pluginDataIO;
  }
}
