import { useEffect, useRef, type ReactNode } from 'react'

// Escape closes only the topmost of stacked dialogs.
const stack: symbol[] = []

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const id = useRef(Symbol(title))
  useEffect(() => {
    const me = id.current
    stack.push(me)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === me) {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      stack.splice(stack.indexOf(me), 1)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <span>{title}</span>
          <button onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
