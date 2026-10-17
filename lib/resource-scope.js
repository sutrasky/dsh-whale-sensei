/** Plugin-owned resources; disposal starts synchronously, and never rejects unobserved. */
export function createResourceScope() {
	const entries = new Set()
	const pending = new Set()
	const errors = []
	let disposed = false
	let disposal
	const scope = {
		get disposed() { return disposed },
		get size() { return entries.size },
		add(disposer) {
			if (typeof disposer !== 'function') throw new TypeError('disposer must be a function')
			let active = true
			let result
			const release = () => {
				if (!active) return result
				active = false
				entries.delete(release)
				try {
					const value = disposer()
					if (value && typeof value.then === 'function') {
						result = Promise.resolve(value).catch(e => { errors.push(e) }).finally(() => pending.delete(result))
						pending.add(result)
					}
				} catch (e) { errors.push(e) }
				return result
			}
			entries.add(release)
			if (disposed) release()
			return release
		},
		child() {
			const child = createResourceScope()
			const release = scope.add(() => child.dispose().then(r => { errors.push(...r.errors) }))
			child.add(() => { release() })
			return child
		},
		dispose() {
			if (disposal) return disposal
			disposed = true
			let resolve
			disposal = new Promise(r => { resolve = r })
			// Invoke every disposer now: jobs withdrawal must invalidate its service synchronously.
			for (const release of [...entries].reverse()) release()
			;(async () => {
				while (pending.size) await Promise.all([...pending])
				resolve({ errors })
			})()
			return disposal
		},
	}
	return scope
}
