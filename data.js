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

var INJECTION_SITES = [
    'Abdomen - Left','Abdomen - Right',
    'Thigh - Left','Thigh - Right',
    'Deltoid - Left','Deltoid - Right',
    'Glute - Left','Glute - Right','Other'
];
