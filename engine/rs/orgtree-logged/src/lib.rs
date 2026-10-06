//! `#[logged]`: per-method invocation logging for the Orgtree engine.
//!
//! On a free function, or on an inherent `impl` block (every method in it),
//! the function body moves into a hidden inner function and a wrapper with
//! the original name logs each call: its arguments on the call line, its
//! return value on the return line, both under one invocation id (a tracing
//! span the engine's `trace` module formats). `#[nolog]` on a method of a
//! logged impl block leaves that method as it is (hot paths).
//!
//! The expansion refers to `crate::trace`, so it is only for the engine crate.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as T2;
use quote::{format_ident, quote, ToTokens};
use syn::{Attribute, Block, FnArg, GenericParam, ImplItem, Item, ItemFn, ItemImpl, Pat, PatIdent, Signature, Visibility};

#[proc_macro_attribute]
pub fn logged(_attr: TokenStream, item: TokenStream) -> TokenStream {
    match syn::parse::<Item>(item) {
        Ok(Item::Fn(f)) => free_fn(f).into(),
        Ok(Item::Impl(i)) => impl_block(i).into(),
        Ok(other) => syn::Error::new_spanned(other, "#[logged] goes on a fn or an inherent impl block")
            .to_compile_error()
            .into(),
        Err(e) => e.to_compile_error().into(),
    }
}

/// Marks a method of a `#[logged]` impl block as not logged.
#[proc_macro_attribute]
pub fn nolog(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}

fn is_nolog(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|a| a.path().is_ident("nolog"))
}

/// const, unsafe and extern functions are left alone.
fn untouchable(sig: &Signature) -> bool {
    sig.constness.is_some() || sig.unsafety.is_some() || sig.abi.is_some() || sig.variadic.is_some()
}

enum Owner {
    Free,
    Method,
    Assoc,
}

fn free_fn(f: ItemFn) -> T2 {
    if untouchable(&f.sig) || f.sig.ident == "main" {
        return f.into_token_stream();
    }
    let name = f.sig.ident.to_string();
    let (wrapper, inner) = build(&f.attrs, &f.vis, &f.sig, &f.block, &name, Owner::Free);
    quote! { #wrapper #inner }
}

fn impl_block(mut i: ItemImpl) -> T2 {
    if i.trait_.is_some() {
        // a trait impl cannot gain items: leave it as written
        for it in i.items.iter_mut() {
            if let ImplItem::Fn(m) = it {
                m.attrs.retain(|a| !a.path().is_ident("nolog"));
            }
        }
        return i.into_token_stream();
    }
    let ty = type_name(&i.self_ty);
    let mut items = Vec::new();
    for it in std::mem::take(&mut i.items) {
        match it {
            ImplItem::Fn(mut m) => {
                if is_nolog(&m.attrs) || untouchable(&m.sig) {
                    m.attrs.retain(|a| !a.path().is_ident("nolog"));
                    items.push(ImplItem::Fn(m));
                    continue;
                }
                let name = format!("{}::{}", ty, m.sig.ident);
                let owner = if m.sig.receiver().is_some() { Owner::Method } else { Owner::Assoc };
                let (w, inner) = build(&m.attrs, &m.vis, &m.sig, &m.block, &name, owner);
                match (syn::parse2::<ImplItem>(w), syn::parse2::<ImplItem>(inner)) {
                    (Ok(w), Ok(inner)) => {
                        items.push(w);
                        items.push(inner);
                    }
                    (Err(e), _) | (_, Err(e)) => return e.to_compile_error(),
                }
            }
            other => items.push(other),
        }
    }
    i.items = items;
    i.into_token_stream()
}

/// `Foo` for `Foo`, `Foo<T>`, `crate::x::Foo<'a>`.
fn type_name(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Path(p) => p.path.segments.last().map(|s| s.ident.to_string()).unwrap_or_else(|| "?".into()),
        other => other.to_token_stream().to_string().replace(' ', ""),
    }
}

/// Arguments whose values say nothing (handles, connections, channels):
/// not shown on the call line.
fn hidden(ty: &str) -> bool {
    const HANDLES: &[&str] = &[
        "Engine", "EngineRef", "Client", "Transaction", "Pool", "Object", "OrgHandle", "AgentHandle", "UnboundedSender",
        "UnboundedReceiver", "Sender", "Receiver", "WebSocket", "WebSocketUpgrade", "Next", "Request", "State",
        "CancellationToken", "ChildStdout", "ChildStderr", "ChildStdin", "Child", "Command", "Formatter", "Dispatch",
        "AppFeedInbox", "SchedInbox", "Out", "AgentTx", "Envelope",
    ];
    ty.split(|c: char| !(c.is_alphanumeric() || c == '_')).any(|w| HANDLES.contains(&w))
}

fn label_of(p: &Pat) -> String {
    match p {
        Pat::Ident(i) => i.ident.to_string(),
        other => other.to_token_stream().to_string().replace(' ', ""),
    }
}

fn build(attrs: &[Attribute], vis: &Visibility, sig: &Signature, block: &Block, name: &str, owner: Owner) -> (T2, T2) {
    let inner_ident = format_ident!("__lg_{}", sig.ident);
    let mut inner_sig = sig.clone();
    inner_sig.ident = inner_ident.clone();
    let body_attrs: Vec<&Attribute> = attrs
        .iter()
        .filter(|a| !a.path().is_ident("doc") && !a.path().is_ident("must_use") && !a.path().is_ident("inline"))
        .collect();
    let inner = quote! {
        #(#body_attrs)*
        #[doc(hidden)]
        #[allow(clippy::too_many_arguments, clippy::needless_lifetimes, non_snake_case)]
        #inner_sig #block
    };

    let mut wsig = sig.clone();
    let mut call_args = Vec::new();
    let mut shows = Vec::new();
    let mut impl_trait = false;
    for (i, arg) in wsig.inputs.iter_mut().enumerate() {
        if let FnArg::Typed(pt) = arg {
            let ident = format_ident!("__lg_a{}", i);
            let label = label_of(&pt.pat);
            let ty = pt.ty.to_token_stream().to_string();
            if ty.contains("impl ") {
                impl_trait = true;
            }
            pt.pat = Box::new(Pat::Ident(PatIdent { attrs: vec![], by_ref: None, mutability: None, ident: ident.clone(), subpat: None }));
            call_args.push(quote!(#ident));
            if !hidden(&ty) && !ty.contains("impl ") {
                shows.push(quote! {
                    __lg_v.push(#label, (&&&&&&&&&crate::trace::show::Show(&#ident)).show());
                });
            }
        }
    }
    let tparams: Vec<_> = sig
        .generics
        .params
        .iter()
        .filter_map(|p| match p {
            GenericParam::Type(t) => Some(t.ident.clone()),
            _ => None,
        })
        .collect();
    let turbofish = if !tparams.is_empty() && !impl_trait { quote!(::<#(#tparams),*>) } else { quote!() };
    let call = match owner {
        Owner::Method => quote!(self.#inner_ident #turbofish (#(#call_args),*)),
        Owner::Assoc => quote!(Self::#inner_ident #turbofish (#(#call_args),*)),
        Owner::Free => quote!(#inner_ident #turbofish (#(#call_args),*)),
    };
    let run = if sig.asyncness.is_some() {
        quote!(::tracing::Instrument::instrument(#call, __lg_f.span()).await)
    } else {
        quote!({
            let __lg_g = __lg_f.enter();
            #call
        })
    };
    let wrapper = quote! {
        #(#attrs)*
        #[allow(unused_mut, clippy::let_and_return)]
        #vis #wsig {
            #[allow(unused_imports)]
            use crate::trace::show::prelude::*;
            static __LG_PATH: ::std::sync::OnceLock<::std::string::String> = ::std::sync::OnceLock::new();
            let __lg_f = crate::trace::Frame::new(
                __LG_PATH.get_or_init(|| crate::trace::dotted(concat!(module_path!(), "::", #name))).as_str(),
            );
            if __lg_f.on() {
                let mut __lg_v = crate::trace::Args::new();
                #(#shows)*
                __lg_f.call(__lg_v);
            }
            let __lg_r = #run;
            if __lg_f.on() {
                __lg_f.ret((&&&&&&&&&crate::trace::show::Show(&__lg_r)).show());
            }
            __lg_r
        }
    };
    (wrapper, inner)
}
