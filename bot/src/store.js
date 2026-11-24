import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = () => ({
  position: null, // { qty, entryPrice, openedAt, dryRun }
  daily: { date: null, trades: 0 },
  realizedPnl: 0,
  history: [],
  lastTick: null,
});

/** Bot durumunu diske JSON olarak yazar (yeniden başlatmada pozisyon kaybolmasın). */
export class JsonStore {
  constructor(file) {
    this.file = file;
    this.state = DEFAULT_STATE();
    if (file && fs.existsSync(file)) {
      this.state = { ...DEFAULT_STATE(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
