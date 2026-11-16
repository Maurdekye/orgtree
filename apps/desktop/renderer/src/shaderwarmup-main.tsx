// Entry of shader-warmup.html (main/shader-warmup.ts). The app's own sheets, then the scene;
// none of main.tsx's engine/preload subscriptions run in this document.
import './styles.css'
import './shell.css'
import { mountShaderWarmup } from './shaderwarmup'

mountShaderWarmup(document.getElementById('root')!)
