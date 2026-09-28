import { render } from 'preact';
import '../ui/tokens.css';
import './settings.css';
import { getPlatform } from '../platform.js';
import { SettingsApp } from './SettingsApp.js';

const root = document.getElementById('app');
if (root) render(<SettingsApp adapter={getPlatform()} />, root);
