import './Skeleton.css'

export default function Skeleton({ width, height, radius, variant = 'rect', className = '' }) {
  const classes = ['skeleton']
  if (variant === 'circle') classes.push('skeleton--circle')
  if (variant === 'text') classes.push('skeleton--text')
  if (className) classes.push(className)

  const style = { width, height }
  if (radius !== undefined) style.borderRadius = radius

  return <span className={classes.join(' ')} style={style} aria-hidden="true" />
}
