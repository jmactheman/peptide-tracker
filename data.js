'use strict';

var PEPTIDE_NAMES = [
    '5-Amino-1MQ','AA Water','ACE-031','AHK-Cu','AOD9604','Adipotide (FTTP)',
    'ARA-290','B12 (Methylcobalamin)','BAC Water','BPC-157','BPC-157 + TB-500 Blend',
    'Botulinum Toxin','Cagrilintide','Cardiogen','Cerebrolysin','CJC-1295 (no DAC)',
    'CJC-1295 + Ipamorelin Blend','CJC-1295 with DAC','Cortagen','Crystagen','DSIP',
    'Dihexa','Epithalon','FOXO4-DRI','GDF-8 (Myostatin)','GHRP-2','GHRP-6','GHK-Cu',
    'GLOW Blend','Glutathione','Gonadorelin','HCG','HGH (Somatropin)',
    'HGH Fragment 176-191','HMG','Healthy Hair Skin Nails Blend','Hexarelin','Humanin',
    'IGF-1 LR3','Ipamorelin','KPV','KissPeptin-10','KLOW Blend','L-Carnitine','LL-37',
    'Lemon Bottle','Lipo-C (with B12)','Lipo-C (without B12)','MOTS-c','MGF','Mazdutide',
    'Melatonin','Melanotan I','Melanotan II','NAD+','Orexin A','Orexin B','Oxytocin',
    'P21 (P021)','PE-22-28','PEG-MGF','PT-141','Pinealon','Relaxation PM Blend',
    'Retatrutide','SS-31 (Elamipretide)','SLU-PP-332','Selank','Semax','Semaglutide',
    'Sermorelin','Snap-8','Sterile Water','Super Human Blend','Survodutide','TB-500',
    'Tesamorelin','Thymalin','Thymosin Alpha-1','Tirzepatide','VIP','Vesugen'
];

// Peptides that default to IU unit when selected
var IU_DEFAULTS = new Set([
    'HGH (Somatropin)','HCG','HMG','Botulinum Toxin'
]);

// Peptides that default to mL unit (reconstitution waters)
var ML_DEFAULTS = new Set([
    'Sterile Water','BAC Water','AA Water'
]);

var PEPTIDE_COLORS = [
    '#3b82f6','#22c55e','#f97316','#ef4444','#a855f7',
    '#06b6d4','#ec4899','#84cc16','#6366f1','#eab308',
    '#78716c','#0d9488'
];

// Peptide classes — used for washout gating between same-class compounds.
// Only classes where back-to-back use warrants a washout are mapped; anything
// not listed is unclassed and never triggers a washout warning.
var PEPTIDE_CLASS = {
    // GHRH analogs (growth-hormone secretagogues — receptor resensitization)
    'Sermorelin':'ghrh','CJC-1295 (no DAC)':'ghrh','CJC-1295 with DAC':'ghrh',
    'CJC-1295 + Ipamorelin Blend':'ghrh','Tesamorelin':'ghrh',
    // Growth-hormone releasing peptides / ghrelin-receptor agonists
    'Ipamorelin':'ghrp','GHRP-2':'ghrp','GHRP-6':'ghrp','Hexarelin':'ghrp',
    // GLP-1 / incretin agonists
    'Semaglutide':'glp1','Tirzepatide':'glp1','Retatrutide':'glp1','Cagrilintide':'glp1',
    'Mazdutide':'glp1','Survodutide':'glp1',
    // Melanocortin agonists
    'Melanotan I':'melanocortin','Melanotan II':'melanocortin','PT-141':'melanocortin'
};

// Human-readable label per class (shown in washout prompts/warnings).
var CLASS_LABELS = {
    ghrh:'GHRH (GH secretagogue)', ghrp:'GHRP / ghrelin',
    glp1:'GLP-1', melanocortin:'melanocortin'
};

// Suggested washout (weeks) per class, used to prefill the end-cycle prompt.
var CLASS_WASHOUT_WEEKS = { ghrh:4, ghrp:4, glp1:4, melanocortin:4 };
var DEFAULT_WASHOUT_WEEKS = 4;

var INJECTION_SITES = [
    'Abdomen - Left','Abdomen - Right',
    'Thigh - Left','Thigh - Right',
    'Deltoid - Left','Deltoid - Right',
    'Glute - Left','Glute - Right','Other'
];
