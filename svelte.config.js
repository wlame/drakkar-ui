import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  // vitePreprocess enables <script lang="ts"> and modern CSS in components.
  preprocess: vitePreprocess(),
}
