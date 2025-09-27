import fs from 'node:fs/promises';
import path from 'node:path';
import type { HourlyStats } from '../core/trading-stats';

export class CSVLogger {
  private readonly filePath: string;
  private initialized: boolean = false;

  constructor(filename: string) {
    // 在 exports 目錄下創建 CSV 文件
    this.filePath = path.join(process.cwd(), 'exports', filename);
  }

  private async ensureDirectoryExists() {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      console.error('Error creating directory:', err);
    }
  }

  private async initializeFile() {
    if (this.initialized) return;
    
    await this.ensureDirectoryExists();
    
    try {
      // 檢查文件是否存在
      try {
        await fs.access(this.filePath);
      } catch {
        // 文件不存在，創建表頭
        const headers = 'timestamp,hourStartTime,makerOrderCount,takerOrderCount,totalFees,totalPnl,totalVolume,pointsRate\n';
        await fs.writeFile(this.filePath, headers, 'utf-8');
      }
      this.initialized = true;
    } catch (err) {
      console.error('Error initializing CSV file:', err);
    }
  }

  async logHourlyStats(stats: HourlyStats) {
    try {
      await this.initializeFile();
      
      const now = new Date();
      const row = [
        now.toISOString(),
        new Date(stats.hourStartTime).toISOString(),
        stats.makerOrderCount,
        stats.takerOrderCount,
        stats.totalFees,
        stats.totalPnl,
        stats.totalVolume,
        stats.pointsRate
      ].join(',') + '\n';

      // 非同步寫入，不阻塞主線程
      await fs.appendFile(this.filePath, row, 'utf-8').catch(err => {
        console.error('Error writing to CSV:', err);
      });
    } catch (err) {
      console.error('Error logging stats:', err);
    }
  }
}

export const tradingStatsLogger = new CSVLogger('trading-stats.csv');