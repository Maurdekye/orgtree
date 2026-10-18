import React from 'react'
import { createRoot } from 'react-dom/client'
import { md } from '../src/canvas/shared'
import '../src/styles.css'

const sample = String.raw`**Inline math** in ordinary Markdown: $E=mc^2$ and \(\frac{a}{b}=\sqrt{2}\).

**Display alignment**

\[
\begin{aligned}
a_1 &= b_2 + c_3 \\
\int_0^1 x^2\,dx &= \frac{1}{3}
\end{aligned}
\]

- Currency stays literal: $5 and $10.
- Code stays literal: ` + '`$x$`' + String.raw`.
- Invalid input stays readable: $\notARealCommand{x}$.

A link with math: [result $x^2$](https://example.com).`

function Fixture() {
  React.useEffect(() => { document.body.dataset.ready = 'true' }, [])
  return <main><h1>Offline Markdown mathematics</h1><section className="sample md" dangerouslySetInnerHTML={md(sample)} /></main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
