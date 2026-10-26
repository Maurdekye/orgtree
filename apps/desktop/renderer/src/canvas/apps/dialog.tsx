import type {ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {AppsIcon} from '../../icons'
import {CurrentOrg,SurfaceDocumentOwner,useSurfaceDocument} from '../../popout'
import {PinFrame} from '../modalpin'

/** Native chrome only. App HTML never supplies this tree or its callbacks. */
export function AppDialog({title,label=title,close,children,owner,kind='custom-app-dialog',org,pinnable=false,className=''}:{
  title:string;label?:string;close:()=>void;children:ReactNode;owner?:Document;kind?:string;org?:string;pinnable?:boolean;className?:string
}){
  const current=useSurfaceDocument(),document=owner??current
  const frame=<SurfaceDocumentOwner owner={document}><PinFrame kind={kind} title={title} panel={'settings custom-app-dialog '+className} dialogLabel={label} close={close} closeInModal pinnable={pinnable}>
    <h3><AppsIcon fontSize="inherit"/> {title}</h3>{children}
  </PinFrame></SurfaceDocumentOwner>
  return createPortal(org?<CurrentOrg.Provider value={org}>{frame}</CurrentOrg.Provider>:frame,document.body)
}
