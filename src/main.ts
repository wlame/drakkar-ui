import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// Svelte 5 mounts a root component onto a DOM node. The #app div lives in
// index.html (the SPA shell every backend serves).
const app = mount(App, { target: document.getElementById('app')! })

export default app
