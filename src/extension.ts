// TopHat: An elegant system resource monitor for the GNOME shell
// Copyright (C) 2020 Todd Kulesza <todd@dropline.net>

// This file is part of TopHat.

// TopHat is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// TopHat is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with TopHat. If not, see <https://www.gnu.org/licenses/>.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { File } from './file.js';
import { Vitals, CpuModel, GpuModel } from './vitals.js';
import { TopHatContainer } from './container.js';
import { CpuMonitor } from './cpu.js';
import { GpuMonitor } from './gpu.js';
import { MemMonitor } from './mem.js';
import { DiskMonitor } from './disk.js';
import { NetMonitor } from './net.js';
import { TopHatMonitor } from './monitor.js';

enum MenuPosition {
  LeftEdge,
  Left,
  Center,
  Right,
  RightEdge,
}

export default class TopHat extends Extension {
  private gsettings?: Gio.Settings;
  private signals = new Array<number>();
  private vitals?: Vitals;
  private container?: TopHatContainer;

  public enable() {
    this.gsettings = this.getSettings();
    const f = new File('/proc/cpuinfo');
    const cpuModel = this.parseCpuOverview(f.readSync());
    const gpuModel = this.parseGpuOverview();
    this.vitals = new Vitals(cpuModel, this.gsettings, gpuModel);
    this.vitals.start();
    this.addToPanel();
    const id = this.gsettings.connect('changed::position-in-panel', () => {
      this.addToPanel();
    });
    this.signals.push(id);
  }

  public disable() {
    this.container?.destroy();
    this.container = undefined;
    this.signals.forEach((s) => {
      this.gsettings?.disconnect(s);
    });
    this.signals.length = 0;
    this.gsettings = undefined;
    this.vitals?.stop();
    this.vitals = undefined;
  }

  private parseCpuOverview(cpuinfo: string): CpuModel {
    const cpus = new Set<number>();
    const tempMonitors = new Map<number, string>();

    // Count the number of physical CPUs
    const blocks = cpuinfo.split('\n\n');
    for (const block of blocks) {
      const m = block.match(/physical id\s*:\s*(\d+)/);
      if (m) {
        const id = parseInt(m[1]);
        cpus.add(id);
      }
    }
    const cores = blocks.length;

    // Find the temperature sensor for each CPU
    const base = '/sys/class/hwmon/';
    const hwmon = new File(base);
    hwmon.listSync().forEach((filename) => {
      // TODO: Add unit tests for each known temperature sensor configuration
      const name = new File(`${base}${filename}/name`).readSync();
      if (name === 'coretemp') {
        // Intel CPUs
        let f = new File(`${base}${filename}/temp1_label`);
        if (!f.exists()) {
          // To support Intel Core systems pre-Sandybridge
          f = new File(`${base}${filename}/temp2_label`);
        }
        if (!f.exists()) {
          console.error(`[TopHat] Found coretemp but no sensor labels`);
          return;
        }
        const prefix = f.readSync();

        // const prefix = new File(`${base}${filename}/temp1_label`)
        let id = 0;
        if (prefix) {
          const m = prefix.match(/Package id\s*(\d+)/);
          if (m) {
            id = parseInt(m[1]);
          }
        }
        let inputPath = `${base}${filename}/temp1_input`;
        if (new File(inputPath).exists()) {
          tempMonitors.set(id, inputPath);
        } else {
          // To support Intel Core systems pre-Sandybridge
          inputPath = `${base}${filename}/temp2_input`;
          if (new File(inputPath).exists()) {
            tempMonitors.set(id, inputPath);
          } else {
            console.error(`[TopHat] Found coretemp but no sensor inputs`);
            return;
          }
        }
      } else if (name === 'k10temp') {
        // AMD CPUs
        // temp2 is Tdie, temp1 is Tctl
        let inputPath = `${base}${filename}/temp2_input`;
        if (!new File(inputPath).exists()) {
          inputPath = `${base}${filename}/temp1_input`;
          if (!new File(inputPath).exists()) {
            console.error(`[TopHat] Found k10temp but no sensor inputs`);
            return;
          }
        }
        tempMonitors.set(0, inputPath);
      } else if (name === 'zenpower') {
        // AMD CPUs w/ alternate kernel driver
        // temp1 is Tdie, temp2 is Tctl
        let inputPath = `${base}${filename}/temp1_input`;
        if (!new File(inputPath).exists()) {
          inputPath = `${base}${filename}/temp2_input`;
          if (!new File(inputPath).exists()) {
            console.error(`[TopHat] Found zenpower but no sensor inputs`);
            return;
          }
        }
        tempMonitors.set(0, inputPath);
      }
    });

    // Get the model name
    const lines = cpuinfo.split('\n');
    const modelRE = /^model name\s*:\s*(.*)$/;
    let model = '';
    for (const line of lines) {
      const m = !model && line.match(modelRE);
      if (m) {
        model = m[1];
        break;
      }
    }

    return new CpuModel(model, cores, cpus.size, tempMonitors);
  }

  private parseGpuOverview(): GpuModel {
    // 1. Check NVIDIA GPU via nvidia-smi if available
    if (GLib.find_program_in_path('nvidia-smi')) {
      try {
        const [ok, stdout, , exitStatus] = GLib.spawn_command_line_sync(
          'nvidia-smi --query-gpu=name --format=csv,noheader'
        );
        if (ok && exitStatus === 0 && stdout) {
          const outStr = new TextDecoder('utf-8').decode(stdout).trim();
          if (outStr) {
            const name = outStr.split('\n')[0].trim();
            return new GpuModel(
              name,
              'nvidia',
              'nvidia',
              null,
              null,
              null,
              null,
              null,
              null,
              true
            );
          }
        }
      } catch {
        // Fall back to sysfs
      }
    }

    // 2. Check DRM cards in sysfs
    const drmBase = '/sys/class/drm';
    const drmDir = new File(drmBase);
    if (drmDir.exists()) {
      const cards = drmDir
        .listSync()
        .filter((c) => /^card\d+$/.test(c))
        .sort();

      for (const card of cards) {
        const devPath = `${drmBase}/${card}/device`;
        const devDir = new File(devPath);
        if (!devDir.exists()) {
          continue;
        }

        let driverName = '';
        try {
          const symlink = Gio.File.new_for_path(`${devPath}/driver`).query_info(
            Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
            Gio.FileQueryInfoFlags.NONE,
            null
          );
          const target = symlink.get_symlink_target();
          if (target) {
            driverName = target.split('/').pop() || '';
          }
        } catch {
          // ignore
        }

        let busyFile: string | null = null;
        if (new File(`${devPath}/gpu_busy_percent`).exists()) {
          busyFile = `${devPath}/gpu_busy_percent`;
        }

        let vramUsedFile: string | null = null;
        let vramTotalFile: string | null = null;
        if (new File(`${devPath}/mem_info_vram_total`).exists()) {
          vramUsedFile = `${devPath}/mem_info_vram_used`;
          vramTotalFile = `${devPath}/mem_info_vram_total`;
        } else if (new File(`${devPath}/mem_info_gtt_total`).exists()) {
          vramUsedFile = `${devPath}/mem_info_gtt_used`;
          vramTotalFile = `${devPath}/mem_info_gtt_total`;
        }

        let tempFile: string | null = null;
        let powerFile: string | null = null;
        let freqFile: string | null = null;

        const hwmonBase = `${devPath}/hwmon`;
        const hwmonDir = new File(hwmonBase);
        if (hwmonDir.exists()) {
          const hwmons = hwmonDir.listSync();
          for (const h of hwmons) {
            const hPath = `${hwmonBase}/${h}`;
            if (new File(`${hPath}/temp1_input`).exists()) {
              tempFile = `${hPath}/temp1_input`;
            }
            if (new File(`${hPath}/power1_average`).exists()) {
              powerFile = `${hPath}/power1_average`;
            } else if (new File(`${hPath}/power1_input`).exists()) {
              powerFile = `${hPath}/power1_input`;
            }
            if (new File(`${hPath}/freq1_input`).exists()) {
              freqFile = `${hPath}/freq1_input`;
            }
            if (tempFile) {
              break;
            }
          }
        }

        if (
          busyFile ||
          driverName === 'amdgpu' ||
          driverName === 'radeon' ||
          driverName === 'i915' ||
          driverName === 'xe'
        ) {
          let name = 'Graphics Processor';
          try {
            const [ok, stdout] = GLib.spawn_command_line_sync('lspci');
            if (ok && stdout) {
              const outStr = new TextDecoder('utf-8').decode(stdout);
              for (const line of outStr.split('\n')) {
                if (
                  /vga compatible controller|3d controller|display controller/i.test(
                    line
                  )
                ) {
                  const parts = line.split(/controller:\s*/i);
                  if (parts[1]) {
                    name = parts[1].replace(/\(rev.*?\)/, '').trim();
                    break;
                  }
                }
              }
            }
          } catch {
            // ignore
          }

          if (name === 'Graphics Processor') {
            if (driverName === 'amdgpu' || driverName === 'radeon') {
              name = 'AMD Radeon Graphics';
            } else if (driverName === 'i915' || driverName === 'xe') {
              name = 'Intel Graphics';
            }
          }

          const type: 'amd' | 'intel' | 'generic' =
            driverName === 'amdgpu' || driverName === 'radeon'
              ? 'amd'
              : driverName === 'i915' || driverName === 'xe'
                ? 'intel'
                : 'generic';

          return new GpuModel(
            name,
            driverName,
            type,
            busyFile,
            vramUsedFile,
            vramTotalFile,
            tempFile,
            powerFile,
            freqFile,
            false
          );
        }
      }
    }

    return new GpuModel(
      'No GPU detected',
      '',
      'generic',
      null,
      null,
      null,
      null,
      null,
      null,
      false
    );
  }

  private addToPanel() {
    if (!this.gsettings) {
      console.warn('[TopHat] error in addToPanel(): gsettings does not exist');
      return;
    }
    this.container?.destroy();
    this.container = new TopHatContainer(0.5, 'TopHat');
    this.container.addMonitor(new CpuMonitor(this.metadata, this.gsettings));
    this.container.addMonitor(new GpuMonitor(this.metadata, this.gsettings));
    this.container.addMonitor(new MemMonitor(this.metadata, this.gsettings));
    this.container.addMonitor(new DiskMonitor(this.metadata, this.gsettings));
    this.container.addMonitor(new NetMonitor(this.metadata, this.gsettings));
    const pref = this.getPreferredPanelAttributes();
    this.container = Main.panel.addToStatusArea(
      'TopHat',
      this.container,
      pref.position,
      pref.box
    );

    this.container?.monitors.forEach((m: TopHatMonitor) => {
      if (this.vitals) {
        m.bindVitals(this.vitals);
        Main.panel._onMenuSet(m);
      }
    });

    // Trigger notifications for properties that were set during init and will not change
    this.vitals?.notify('cpu-model');
    this.vitals?.notify('gpu-model');
    this.vitals?.notify('summary-interval');
  }

  private getPreferredPanelAttributes() {
    let box = 'right';
    let position = 0;
    switch (this.gsettings?.get_enum('position-in-panel')) {
      case MenuPosition.LeftEdge:
        box = 'left';
        position = 0;
        break;
      case MenuPosition.Left:
        box = 'left';
        position = -1;
        break;
      case MenuPosition.Center:
        box = 'center';
        position = 1;
        break;
      case MenuPosition.Right:
        box = 'right';
        position = 0;
        break;
      case MenuPosition.RightEdge:
        box = 'right';
        position = -1;
        break;
      default:
        console.warn('[TopHat] Unknown value for position-in-panel');
    }
    return { box, position };
  }
}
