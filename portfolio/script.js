// Theme Toggle
const themeToggle = document.querySelector('.theme-toggle');
const html = document.documentElement;

// Check for saved theme preference or use system preference
const savedTheme = localStorage.getItem('theme');
if (savedTheme) {
    html.setAttribute('data-theme', savedTheme);
    if (savedTheme === 'dark') {
        html.classList.add('dark-mode');
    }
} else {
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (systemPrefersDark) {
        html.classList.add('dark-mode');
        html.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
    }
}

themeToggle.addEventListener('click', () => {
    if (html.classList.contains('dark-mode')) {
        html.classList.remove('dark-mode');
        html.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
    } else {
        html.classList.add('dark-mode');
        html.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
    }
});

// Form Handling
const contactForm = document.getElementById('contactForm');
const formMessage = document.getElementById('formMessage');

contactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    // Simple validation
    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const message = document.getElementById('message').value.trim();
    
    if (!name || !email || !message) {
        showMessage('Please fill in all fields', 'error');
        return;
    }
    
    if (!isValidEmail(email)) {
        showMessage('Please enter a valid email', 'error');
        return;
    }
    
    // Simulate form submission (in real app, this would send to server)
    showMessage('Message sent successfully!', 'success');
    contactForm.reset();
    
    // Log to console for demo
    console.log('Form submitted:', { name, email, message });
});

function showMessage(text, type) {
    formMessage.textContent = text;
    formMessage.className = `form-message ${type}`;
    formMessage.style.display = 'block';
    
    // Hide after 3 seconds
    setTimeout(() => {
        formMessage.style.display = 'none';
    }, 3000);
}

function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// Custom Cursor
const cursorInner = document.querySelector('.cursor-inner');
const cursorOuter = document.querySelector('.cursor-outer');

document.addEventListener('mousemove', (e) => {
    cursorInner.style.left = e.x + 'px';
    cursorInner.style.top = e.y + 'px';
    cursorOuter.style.left = e.x + 'px';
    cursorOuter.style.top = e.y + 'px';
});

// Cursor hover effects
const hoverableElements = document.querySelectorAll('a, button, .skill-card, .project-card, .btn, .project-link, .social-links a, .theme-toggle');

hoverableElements.forEach(el => {
    el.addEventListener('mouseenter', () => {
        cursorInner.classList.add('hover');
        cursorOuter.classList.add('hover');
    });
    
    el.addEventListener('mouseleave', () => {
        cursorInner.classList.remove('hover');
        cursorOuter.classList.remove('hover');
    });
});

// Scroll Animations
const fadeElements = document.querySelectorAll('.fade-in-up');

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
        }
    });
}, {
    threshold: 0.1
});

fadeElements.forEach(el => {
    observer.observe(el);
});

// Radar Chart (simplified SVG)
function drawRadarChart() {
    const radarChart = document.querySelector('.radar-chart');
    if (!radarChart) return;
    
    // Skills data
    const skills = [
        { name: 'Natural Language', value: 95 },
        { name: 'Task Automation', value: 90 },
        { name: 'Code Assistance', value: 85 },
        { name: 'Information Retrieval', value: 80 },
        { name: 'Privacy Focused', value: 100 },
        { name: 'Customizable', value: 88 }
    ];
    
    const containerWidth = radarChart.clientWidth;
    const containerHeight = radarChart.clientHeight;
    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;
    const radius = Math.min(centerX, centerY) - 20;
    
    // Create SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', containerWidth);
    svg.setAttribute('height', containerHeight);
    svg.setAttribute('style', 'position: absolute; top: 0; left: 0;');
    
    // Grid lines (3 levels)
    for (let level = 1; level <= 3; level++) {
        const levelRadius = radius * (level / 3);
        const points = [];
        
        for (let i = 0; i < skills.length; i++) {
            const angle = (i * Math.PI * 2) / skills.length - Math.PI / 2;
            const x = centerX + levelRadius * Math.cos(angle);
            const y = centerY + levelRadius * Math.sin(angle);
            points.push(`${x},${y}`);
        }
        
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', points.join(' '));
        polygon.setAttribute('fill', 'none');
        polygon.setAttribute('stroke', '#ddd');
        polygon.setAttribute('stroke-width', '1');
        svg.appendChild(polygon);
    }
    
    // Skill polygon
    const skillPoints = [];
    for (let i = 0; i < skills.length; i++) {
        const angle = (i * Math.PI * 2) / skills.length - Math.PI / 2;
        const skillRadius = radius * (skills[i].value / 100);
        const x = centerX + skillRadius * Math.cos(angle);
        const y = centerY + skillRadius * Math.sin(angle);
        skillPoints.push(`${x},${y}`);
    }
    
    const skillPolygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    skillPolygon.setAttribute('points', skillPoints.join(' '));
    skillPolygon.setAttribute('fill', 'rgba(0,123,255,0.2)');
    skillPolygon.setAttribute('stroke', 'rgba(0,123,255,0.6)');
    skillPolygon.setAttribute('stroke-width', '2');
    svg.appendChild(skillPolygon);
    
    // Skill points (circles)
    for (let i = 0; i < skills.length; i++) {
        const angle = (i * Math.PI * 2) / skills.length - Math.PI / 2;
        const skillRadius = radius * (skills[i].value / 100);
        const x = centerX + skillRadius * Math.cos(angle);
        const y = centerY + skillRadius * Math.sin(angle);
        
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', x);
        circle.setAttribute('cy', y);
        circle.setAttribute('r', '4');
        circle.setAttribute('fill', 'rgba(0,123,255,0.8)');
        svg.appendChild(circle);
    }
    
    // Labels
    for (let i = 0; i < skills.length; i++) {
        const angle = (i * Math.PI * 2) / skills.length - Math.PI / 2;
        const labelRadius = radius + 20;
        const x = centerX + labelRadius * Math.cos(angle);
        const y = centerY + labelRadius * Math.sin(angle);
        
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('font-size', '10');
        text.setAttribute('fill', '#333');
        text.textContent = skills[i].name;
        svg.appendChild(text);
    }
    
    radarChart.appendChild(svg);
}

// Initialize radar chart when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure dimensions are correct
    setTimeout(drawRadarChart, 100);
    
    // Redraw on resize
    window.addEventListener('resize', () => {
        // Clear existing SVG
        const radarChart = document.querySelector('.radar-chart');
        if (radarChart) {
            radarChart.innerHTML = '';
        }
        setTimeout(drawRadarChart, 100);
    });
});

// Add visible class to elements for animation
document.addEventListener('DOMContentLoaded', () => {
    const fadeElements = document.querySelectorAll('.fade-in-up');
    fadeElements.forEach((el, index) => {
        el.style.animationDelay = `${index * 0.1}s`;
    });
});

// Handle touch events for mobile
document.addEventListener('touchstart', (e) => {
    // Prevent touch from interfering with custom cursor
    e.preventDefault();
}, { passive: false });