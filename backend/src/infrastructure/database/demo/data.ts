/**
 * Fixed content of the rich demo data (see seed.ts). Everything here is plain data; the random parts
 * (student names, marks, attendance) come from `rng` seeded per institute, so every run produces the
 * same records.
 */

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
  };
}
export type Rng = ReturnType<typeof rng>;

export const BOY_NAMES = [
  'Aarav',
  'Vihaan',
  'Arjun',
  'Reyansh',
  'Sai',
  'Krishna',
  'Ishaan',
  'Shaurya',
  'Atharv',
  'Kabir',
  'Ayaan',
  'Dhruv',
  'Om',
  'Pranav',
  'Rudra',
  'Yash',
  'Siddharth',
  'Tanmay',
  'Harsh',
  'Nikhil',
  'Aniket',
  'Parth',
  'Soham',
  'Varun',
] as const;
export const GIRL_NAMES = [
  'Ananya',
  'Diya',
  'Saanvi',
  'Aadhya',
  'Ira',
  'Myra',
  'Kavya',
  'Riya',
  'Sneha',
  'Tanvi',
  'Pooja',
  'Shruti',
  'Anika',
  'Mrunal',
  'Sakshi',
  'Gauri',
  'Nidhi',
  'Aditi',
  'Vaishnavi',
  'Prachi',
  'Janhavi',
  'Khushi',
  'Meera',
  'Ishita',
] as const;
export const SURNAMES = [
  'Sharma',
  'Deshmukh',
  'Joshi',
  'Kulkarni',
  'Patil',
  'Gupta',
  'Verma',
  'Iyer',
  'Nair',
  'Reddy',
  'Agarwal',
  'Jain',
  'Mehta',
  'Shah',
  'Chavan',
  'Pawar',
  'Bhosale',
  'Rathore',
  'Choudhary',
  'Mishra',
  'Saxena',
  'Gaikwad',
  'Shinde',
  'Rao',
] as const;
export const FATHER_NAMES = [
  'Rajesh',
  'Sunil',
  'Anil',
  'Sanjay',
  'Mahesh',
  'Ramesh',
  'Vijay',
  'Prakash',
  'Ashok',
  'Deepak',
  'Manoj',
  'Sachin',
  'Rahul',
  'Amit',
  'Nitin',
  'Girish',
] as const;

export interface SubjectDef {
  code: string;
  name: string;
}
export const SUBJECTS: SubjectDef[] = [
  { code: 'PHY', name: 'Physics' },
  { code: 'CHEM', name: 'Chemistry' },
  { code: 'MATH', name: 'Mathematics' },
  { code: 'BIO', name: 'Biology' },
];

export interface CourseDef {
  code: string;
  name: string;
  description: string;
  subjects: string[];
  /** Branch indexes that offer the course. */
  branches: number[];
  years: number;
  fee: { components: { name: string; amount: number }[]; plan: 'quarterly' | 'monthly'; count: number };
}

export interface BatchDef {
  code: string;
  name: string;
  course: string;
  branch: number;
  capacity: number;
  /** Daily slot, Monday to Saturday; one subject per day in rotation. */
  start: string;
  end: string;
  classroom: string;
  students: number;
  /** Teacher (key in `teachers`) per subject code. */
  teachers: Record<string, string>;
}

export interface TeacherDef {
  /** 'demo' = the institute's existing demo teacher login. */
  key: string;
  name: string;
  subject: string;
  designation: string;
  basic: number;
}

export interface StaffDef {
  name: string;
  designation: string;
  department: string;
  basic: number;
}

export interface InstituteDemo {
  slug: string;
  /** Digit after 962 in the new mobile numbers (962 + digit + kind digit + 5 digits). */
  digit: number;
  /** Mobile prefix of the existing demo logins (91 Apex, 92 Zenith). */
  loginPrefix: string;
  seed: number;
  city: string;
  state: string;
  /** Branch names from the base demo seed, in order. */
  branchNames: string[];
  courses: CourseDef[];
  batches: BatchDef[];
  teachers: TeacherDef[];
  staff: StaffDef[];
  classrooms: { branch: number; name: string; capacity: number }[];
}

const rupees = (r: number) => r * 100;

export const DEMO_INSTITUTES: InstituteDemo[] = [
  {
    slug: 'apex',
    digit: 1,
    loginPrefix: '91',
    seed: 20261,
    city: 'Pune',
    state: 'Maharashtra',
    branchNames: ['Kothrud', 'Baner'],
    courses: [
      {
        code: 'JEE-2Y',
        name: 'JEE Main + Advanced (2 Years)',
        description: 'Two-year classroom programme for JEE Main and Advanced with weekly tests.',
        subjects: ['PHY', 'CHEM', 'MATH'],
        branches: [0, 1],
        years: 2,
        fee: {
          components: [
            { name: 'Tuition fee', amount: rupees(150000) },
            { name: 'Study material', amount: rupees(20000) },
            { name: 'Test series', amount: rupees(15000) },
          ],
          plan: 'quarterly',
          count: 4,
        },
      },
      {
        code: 'NEET-2Y',
        name: 'NEET UG (2 Years)',
        description: 'Two-year NEET UG programme: NCERT-first teaching, daily practice papers, mock tests.',
        subjects: ['PHY', 'CHEM', 'BIO'],
        branches: [0],
        years: 2,
        fee: {
          components: [
            { name: 'Tuition fee', amount: rupees(135000) },
            { name: 'Study material', amount: rupees(18000) },
            { name: 'Test series', amount: rupees(12000) },
          ],
          plan: 'quarterly',
          count: 4,
        },
      },
      {
        code: 'FND-10',
        name: 'Foundation Class X (Boards + Olympiad)',
        description: 'Class X board preparation with Olympiad and NTSE foundation.',
        subjects: ['PHY', 'CHEM', 'MATH', 'BIO'],
        branches: [1],
        years: 1,
        fee: {
          components: [{ name: 'Tuition fee', amount: rupees(72000) }],
          plan: 'monthly',
          count: 10,
        },
      },
    ],
    batches: [
      {
        code: 'JEE27-KM',
        name: 'JEE 2027 Morning (Kothrud)',
        course: 'JEE-2Y',
        branch: 0,
        capacity: 60,
        start: '07:30',
        end: '09:00',
        classroom: 'Room 101',
        students: 10,
        teachers: { PHY: 'demo', CHEM: 'sneha', MATH: 'vikram' },
      },
      {
        code: 'NEET27-KE',
        name: 'NEET 2027 (Kothrud)',
        course: 'NEET-2Y',
        branch: 0,
        capacity: 60,
        start: '10:00',
        end: '11:30',
        classroom: 'Room 102',
        students: 9,
        teachers: { PHY: 'rajesh', CHEM: 'sneha', BIO: 'ananya' },
      },
      {
        code: 'JEE27-BE',
        name: 'JEE 2027 Evening (Baner)',
        course: 'JEE-2Y',
        branch: 1,
        capacity: 50,
        start: '14:00',
        end: '15:30',
        classroom: 'Hall A',
        students: 9,
        teachers: { PHY: 'rajesh', CHEM: 'sneha', MATH: 'vikram' },
      },
      {
        code: 'FND10-B',
        name: 'Foundation X (Baner)',
        course: 'FND-10',
        branch: 1,
        capacity: 40,
        start: '16:30',
        end: '18:00',
        classroom: 'Room 201',
        students: 8,
        teachers: { PHY: 'prakash', CHEM: 'sneha', MATH: 'vikram', BIO: 'ananya' },
      },
    ],
    teachers: [
      { key: 'demo', name: '', subject: 'PHY', designation: 'Senior Physics Faculty', basic: rupees(85000) },
      {
        key: 'rajesh',
        name: 'Rajesh Kulkarni',
        subject: 'PHY',
        designation: 'Physics Faculty',
        basic: rupees(72000),
      },
      {
        key: 'sneha',
        name: 'Sneha Iyer',
        subject: 'CHEM',
        designation: 'HOD Chemistry',
        basic: rupees(90000),
      },
      {
        key: 'vikram',
        name: 'Vikram Joshi',
        subject: 'MATH',
        designation: 'Mathematics Faculty',
        basic: rupees(80000),
      },
      {
        key: 'ananya',
        name: 'Ananya Deshpande',
        subject: 'BIO',
        designation: 'Biology Faculty',
        basic: rupees(65000),
      },
      {
        key: 'prakash',
        name: 'Prakash Rao',
        subject: 'PHY',
        designation: 'Foundation Faculty',
        basic: rupees(48000),
      },
    ],
    staff: [
      {
        name: 'Sunita Pawar',
        designation: 'Office Manager',
        department: 'Administration',
        basic: rupees(32000),
      },
      {
        name: 'Ganesh More',
        designation: 'Office Assistant',
        department: 'Administration',
        basic: rupees(18000),
      },
    ],
    classrooms: [
      { branch: 0, name: 'Room 101', capacity: 60 },
      { branch: 0, name: 'Room 102', capacity: 60 },
      { branch: 1, name: 'Hall A', capacity: 80 },
      { branch: 1, name: 'Room 201', capacity: 40 },
    ],
  },
  {
    slug: 'zenith',
    digit: 2,
    loginPrefix: '92',
    seed: 20262,
    city: 'Jaipur',
    state: 'Rajasthan',
    branchNames: ['Malviya Nagar', 'Vaishali Nagar'],
    courses: [
      {
        code: 'JEE-1Y',
        name: 'JEE Main Crash (1 Year)',
        description: 'One-year JEE Main programme for Class XII and droppers.',
        subjects: ['PHY', 'CHEM', 'MATH'],
        branches: [0, 1],
        years: 1,
        fee: {
          components: [
            { name: 'Tuition fee', amount: rupees(85000) },
            { name: 'Study material', amount: rupees(10000) },
          ],
          plan: 'quarterly',
          count: 4,
        },
      },
      {
        code: 'NEET-RP',
        name: 'NEET Repeater (1 Year)',
        description: 'Intensive one-year NEET programme for repeaters.',
        subjects: ['PHY', 'CHEM', 'BIO'],
        branches: [1],
        years: 1,
        fee: {
          components: [
            { name: 'Tuition fee', amount: rupees(78000) },
            { name: 'Test series', amount: rupees(7000) },
          ],
          plan: 'quarterly',
          count: 4,
        },
      },
    ],
    batches: [
      {
        code: 'JEE27-MN',
        name: 'JEE 2027 (Malviya Nagar)',
        course: 'JEE-1Y',
        branch: 0,
        capacity: 50,
        start: '08:00',
        end: '09:30',
        classroom: 'Room A1',
        students: 9,
        teachers: { PHY: 'demo', CHEM: 'kavita', MATH: 'arvind' },
      },
      {
        code: 'NEET27-VN',
        name: 'NEET Repeater 2027 (Vaishali Nagar)',
        course: 'NEET-RP',
        branch: 1,
        capacity: 50,
        start: '11:00',
        end: '12:30',
        classroom: 'Room V1',
        students: 8,
        teachers: { PHY: 'arvind', CHEM: 'kavita', BIO: 'pooja' },
      },
    ],
    teachers: [
      { key: 'demo', name: '', subject: 'PHY', designation: 'Physics Faculty', basic: rupees(60000) },
      {
        key: 'kavita',
        name: 'Kavita Rathore',
        subject: 'CHEM',
        designation: 'Chemistry Faculty',
        basic: rupees(58000),
      },
      {
        key: 'arvind',
        name: 'Arvind Saxena',
        subject: 'MATH',
        designation: 'Mathematics Faculty',
        basic: rupees(62000),
      },
      {
        key: 'pooja',
        name: 'Pooja Mishra',
        subject: 'BIO',
        designation: 'Biology Faculty',
        basic: rupees(55000),
      },
    ],
    staff: [
      {
        name: 'Ramesh Choudhary',
        designation: 'Front Office Executive',
        department: 'Administration',
        basic: rupees(20000),
      },
    ],
    classrooms: [
      { branch: 0, name: 'Room A1', capacity: 50 },
      { branch: 1, name: 'Room V1', capacity: 50 },
    ],
  },
];

/** Single-answer MCQs (answer = index of the correct option). */
export const QUESTIONS: {
  subject: string;
  text: string;
  options: string[];
  answer: number;
  difficulty: 'easy' | 'medium' | 'hard';
}[] = [
  {
    subject: 'PHY',
    text: 'The SI unit of impulse is',
    options: ['N s', 'N/s', 'kg m/s²', 'J s'],
    answer: 0,
    difficulty: 'easy',
  },
  {
    subject: 'PHY',
    text: 'A body thrown vertically up returns after 6 s (g = 10 m/s²). Its initial speed was',
    options: ['20 m/s', '30 m/s', '45 m/s', '60 m/s'],
    answer: 1,
    difficulty: 'medium',
  },
  {
    subject: 'PHY',
    text: 'The dimensional formula of Planck’s constant is',
    options: ['[ML²T⁻¹]', '[MLT⁻²]', '[ML²T⁻²]', '[M⁰L⁰T⁰]'],
    answer: 0,
    difficulty: 'medium',
  },
  {
    subject: 'CHEM',
    text: 'The hybridisation of carbon in ethyne is',
    options: ['sp³', 'sp²', 'sp', 'dsp²'],
    answer: 2,
    difficulty: 'easy',
  },
  {
    subject: 'CHEM',
    text: 'Which of these has the highest first ionisation enthalpy?',
    options: ['Na', 'Mg', 'Al', 'Ne'],
    answer: 3,
    difficulty: 'easy',
  },
  {
    subject: 'CHEM',
    text: 'The number of moles in 22 g of CO₂ is',
    options: ['0.25', '0.5', '1', '2'],
    answer: 1,
    difficulty: 'easy',
  },
  {
    subject: 'MATH',
    text: 'The derivative of sin²x is',
    options: ['2 sin x', 'sin 2x', 'cos²x', '2 cos x'],
    answer: 1,
    difficulty: 'easy',
  },
  {
    subject: 'MATH',
    text: 'The sum of the roots of x² − 5x + 6 = 0 is',
    options: ['5', '−5', '6', '−6'],
    answer: 0,
    difficulty: 'easy',
  },
  {
    subject: 'MATH',
    text: '∫₀¹ x² dx equals',
    options: ['1/2', '1/3', '1/4', '1'],
    answer: 1,
    difficulty: 'medium',
  },
  {
    subject: 'BIO',
    text: 'The powerhouse of the cell is the',
    options: ['Nucleus', 'Ribosome', 'Mitochondrion', 'Golgi body'],
    answer: 2,
    difficulty: 'easy',
  },
  {
    subject: 'BIO',
    text: 'Which blood group is the universal donor?',
    options: ['A', 'B', 'AB', 'O negative'],
    answer: 3,
    difficulty: 'easy',
  },
  {
    subject: 'BIO',
    text: 'Photosynthesis takes place in the',
    options: ['Chloroplast', 'Mitochondrion', 'Vacuole', 'Lysosome'],
    answer: 0,
    difficulty: 'easy',
  },
];

export const RESOURCES: Record<string, { title: string; url: string }[]> = {
  PHY: [
    { title: 'NCERT Physics Part 1 (Class XI)', url: 'https://ncert.nic.in/textbook.php?keph1=0-7' },
    { title: 'Kinematics: formula sheet', url: 'https://example.com/demo/kinematics-formula-sheet.pdf' },
  ],
  CHEM: [
    { title: 'NCERT Chemistry Part 1 (Class XI)', url: 'https://ncert.nic.in/textbook.php?kech1=0-6' },
    { title: 'Chemical bonding: revision notes', url: 'https://example.com/demo/chemical-bonding-notes.pdf' },
  ],
  MATH: [
    { title: 'NCERT Mathematics (Class XI)', url: 'https://ncert.nic.in/textbook.php?kemh1=0-14' },
    { title: 'Quadratic equations: practice set', url: 'https://example.com/demo/quadratics-practice.pdf' },
  ],
  BIO: [
    { title: 'NCERT Biology (Class XI)', url: 'https://ncert.nic.in/textbook.php?kebo1=0-19' },
    { title: 'Cell, the unit of life: mind map', url: 'https://example.com/demo/cell-mind-map.pdf' },
  ],
};

export const ENQUIRIES: { course: number; source: string; status: string; note: string }[] = [
  {
    course: 0,
    source: 'walk_in',
    status: 'new',
    note: 'Walked in with father, wants a scholarship test date.',
  },
  {
    course: 0,
    source: 'website',
    status: 'contacted',
    note: 'Asked about the batch timings and fee instalments.',
  },
  { course: 1, source: 'phone', status: 'follow_up', note: 'Will visit with parents on Saturday.' },
  {
    course: 1,
    source: 'referral',
    status: 'interested',
    note: 'Referred by a current student; wants a demo class.',
  },
  {
    course: 0,
    source: 'social_media',
    status: 'not_interested',
    note: 'Joined another institute closer to home.',
  },
  {
    course: 1,
    source: 'advertisement',
    status: 'lost',
    note: 'Fee too high for the family; no response since.',
  },
  { course: 0, source: 'website', status: 'new', note: 'Dropper, scored 82 percentile in JEE Main.' },
  { course: 1, source: 'walk_in', status: 'follow_up', note: 'Needs hostel information.' },
];

export const EXPENSE_CATEGORIES = [
  'Rent',
  'Electricity',
  'Marketing',
  'Stationery & printing',
  'Internet & phone',
  'Housekeeping',
];
