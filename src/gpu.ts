// Copyright (C) 2024 Todd Kulesza <todd@dropline.net>

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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
  ExtensionMetadata,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { CapacityBar } from './capacity.js';
import {
  bytesToHumanString,
  DisplayType,
  getDisplayTypeSetting,
} from './helpers.js';
import { HistoryChart } from './history.js';
import { Orientation } from './meter.js';
import { TopHatMonitor, MeterNoVal } from './monitor.js';
import { Vitals } from './vitals.js';

export const GpuMonitor = GObject.registerClass(
  class GpuMonitor extends TopHatMonitor {
    private usage;
    private menuGpuUsage;
    private menuGpuCap;
    private menuGpuModel;
    private menuGpuFreq;
    private menuGpuTemp;
    private menuGpuPower;
    private menuVramUsage;
    private menuVramCap;
    private menuVramSize;
    private displayType: DisplayType;

    constructor(metadata: ExtensionMetadata, gsettings: Gio.Settings) {
      super('GPU Monitor', metadata, gsettings);

      const gicon = Gio.icon_new_for_string(
        `${this.metadata.path}/icons/hicolor/scalable/actions/gpu-icon-symbolic.svg`
      );
      this.icon.set_gicon(gicon);

      this.usage = new St.Label({
        text: MeterNoVal,
        style_class: 'tophat-panel-usage',
        y_align: Clutter.ActorAlign.CENTER,
      });
      this.add_child(this.usage);

      this.meter.setNumBars(1);
      this.meter.setOrientation(Orientation.Vertical);
      this.add_child(this.meter);

      this.menuGpuUsage = new St.Label();
      this.menuGpuCap = new CapacityBar();
      this.menuGpuModel = new St.Label();
      this.menuGpuFreq = new St.Label();
      this.menuGpuTemp = new St.Label();
      this.menuGpuPower = new St.Label();
      this.menuVramUsage = new St.Label();
      this.menuVramCap = new CapacityBar();
      this.menuVramSize = new St.Label();
      this.historyChart = new HistoryChart();

      this.displayType = this.updateDisplayType();
      let id = this.gsettings.connect('changed::gpu-display', () => {
        this.updateDisplayType();
      });
      this.settingsSignals.push(id);

      this.visible = gsettings.get_boolean('show-gpu');
      id = this.gsettings.connect(
        'changed::show-gpu',
        (settings: Gio.Settings) => {
          this.visible = settings.get_boolean('show-gpu');
        }
      );
      this.settingsSignals.push(id);

      this.buildMenu();
      this.addMenuButtons();
      this.updateColor();
    }

    private updateDisplayType() {
      this.displayType = getDisplayTypeSetting(this.gsettings, 'gpu-display');
      if (this.displayType === DisplayType.Both) {
        this.usage.show();
        this.meter.show();
      } else {
        if (this.displayType === DisplayType.Chart) {
          this.usage.hide();
          this.meter.show();
        } else {
          this.usage.show();
          this.meter.hide();
        }
      }
      return this.displayType;
    }

    private buildMenu() {
      let label = new St.Label({
        text: _('Graphics processor'),
        style_class: 'tophat-menu-header',
      });
      this.addMenuRow(label, 0, 2, 1);

      label = new St.Label({
        text: _('GPU utilization:'),
        style_class: 'tophat-menu-label',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuGpuUsage.text = MeterNoVal;
      this.menuGpuUsage.add_style_class_name('tophat-menu-value');
      this.addMenuRow(this.menuGpuUsage, 1, 1, 1);
      this.menuGpuCap.add_style_class_name('tophat-menu-section-end');
      this.addMenuRow(this.menuGpuCap, 0, 2, 1);

      this.menuGpuModel.text = _(`model ${MeterNoVal}`);
      this.menuGpuModel.add_style_class_name(
        'tophat-menu-label tophat-menu-details'
      );
      this.menuGpuModel.set_x_expand(true);
      this.addMenuRow(this.menuGpuModel, 0, 2, 1);

      label = new St.Label({
        text: _('Temperature:'),
        style_class: 'tophat-menu-label tophat-menu-details',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuGpuTemp.text = MeterNoVal;
      this.menuGpuTemp.add_style_class_name(
        'tophat-menu-value tophat-menu-details'
      );
      this.addMenuRow(this.menuGpuTemp, 1, 1, 1);

      label = new St.Label({
        text: _('Frequency:'),
        style_class: 'tophat-menu-label tophat-menu-details',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuGpuFreq.text = MeterNoVal;
      this.menuGpuFreq.add_style_class_name(
        'tophat-menu-value tophat-menu-details'
      );
      this.addMenuRow(this.menuGpuFreq, 1, 1, 1);

      label = new St.Label({
        text: _('Power draw:'),
        style_class:
          'tophat-menu-label tophat-menu-details tophat-menu-section-end',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuGpuPower.text = MeterNoVal;
      this.menuGpuPower.add_style_class_name(
        'tophat-menu-value tophat-menu-details tophat-menu-section-end'
      );
      this.addMenuRow(this.menuGpuPower, 1, 1, 1);

      label = new St.Label({
        text: _('VRAM used:'),
        style_class: 'tophat-menu-label',
      });
      this.addMenuRow(label, 0, 1, 1);
      this.menuVramUsage.text = MeterNoVal;
      this.menuVramUsage.add_style_class_name('tophat-menu-value');
      this.addMenuRow(this.menuVramUsage, 1, 1, 1);
      this.addMenuRow(this.menuVramCap, 0, 2, 1);
      this.menuVramSize.text = _(`size ${MeterNoVal}`);
      this.menuVramSize.add_style_class_name(
        'tophat-menu-details align-right tophat-menu-section-end'
      );
      this.addMenuRow(this.menuVramSize, 0, 2, 1);

      if (this.historyChart) {
        this.addMenuRow(this.historyChart, 0, 2, 1);
      }
    }

    public override bindVitals(vitals: Vitals): void {
      super.bindVitals(vitals);

      let id = vitals.connect('notify::gpu-usage', () => {
        const percent = vitals.gpu_usage * 100;
        const s = percent.toFixed(0) + '%';
        this.usage.text = s;
        this.menuGpuUsage.text = s;
        this.menuGpuCap.setUsage(vitals.gpu_usage);
        this.meter.setBarSizes([vitals.gpu_usage]);
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-model', () => {
        this.menuGpuModel.text = vitals.gpu_model;
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-temp', () => {
        if (vitals.gpu_temp > 0) {
          this.menuGpuTemp.text = vitals.gpu_temp.toFixed(0) + ' °C';
        } else {
          this.menuGpuTemp.text = MeterNoVal;
        }
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-freq', () => {
        if (vitals.gpu_freq > 0) {
          this.menuGpuFreq.text = vitals.gpu_freq + ' MHz';
        } else {
          this.menuGpuFreq.text = MeterNoVal;
        }
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-power', () => {
        if (vitals.gpu_power > 0) {
          this.menuGpuPower.text = vitals.gpu_power + ' W';
        } else {
          this.menuGpuPower.text = MeterNoVal;
        }
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-vram-usage', () => {
        const percent = vitals.gpu_vram_usage * 100;
        const s = percent.toFixed(0) + '%';
        this.menuVramUsage.text = s;
        this.menuVramCap.setUsage(vitals.gpu_vram_usage);
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-vram-size', () => {
        const total = bytesToHumanString(vitals.gpu_vram_size);
        const free = bytesToHumanString(vitals.gpu_vram_size_free);
        this.menuVramSize.text = _(`${free} free of ${total}`);
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-vram-size-free', () => {
        const total = bytesToHumanString(vitals.gpu_vram_size);
        const free = bytesToHumanString(vitals.gpu_vram_size_free);
        this.menuVramSize.text = _(`${free} free of ${total}`);
      });
      this.vitalsSignals.push(id);

      id = vitals.connect('notify::gpu-history', () => {
        this.historyChart?.update(vitals.getGpuHistory());
      });
      this.vitalsSignals.push(id);
    }

    protected override updateColor(): [string, boolean] {
      const [color, useAccent] = super.updateColor();
      this.menuGpuCap?.setColor(color);
      this.menuVramCap?.setColor(color);
      return [color, useAccent];
    }
  }
);

export type GpuMonitor = InstanceType<typeof GpuMonitor>;
