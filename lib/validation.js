// Shared climb-hold validation — the authoritative copy of the UI rules.
function validateClimbHolds(holds) {
    if (!Array.isArray(holds) || holds.length === 0) return 'at least one hold is required';
    const counts = {};
    for (const h of holds) counts[h.role] = (counts[h.role] || 0) + 1;
    if (!counts.start) return 'a start hold is required';
    if (!counts.finish) return 'a finish hold is required';
    if (!counts.hand) return 'a hybrid hold is required';
    if (counts.start > 2) return 'max 2 start holds';
    if (counts.finish > 2) return 'max 2 finish holds';
    return null;
}

module.exports = { validateClimbHolds };
