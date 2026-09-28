import { render } from 'preact';
import '../ui/tokens.css';
import './sidepanel.css';
import { getPlatform } from '../platform.js';
import { App } from './App.js';

const root = document.getElementById('app');
if (root) render(<App adapter={getPlatform()} />, root);
