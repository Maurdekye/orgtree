import { createRoot } from 'react-dom/client'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { installGalleryFixture } from './galleryrows-fixture'
import '../src/styles.css'

installGalleryFixture()
const props={slug:'synthetic',toast:()=>{},onFocusAgent:()=>{}}
const modal=new URLSearchParams(location.search).get('surface')==='modal'
createRoot(document.getElementById('root')!).render(modal ? <DocGalleryModal {...props} close={()=>{}} />
  : <div className="settings" style={{position:'absolute',inset:16,width:'auto',height:'auto',maxHeight:'none'}}>
    <AgentGalleryView {...props} nid="test-project" node={{id:'test-project',kind:'project'} as any} />
  </div>)
