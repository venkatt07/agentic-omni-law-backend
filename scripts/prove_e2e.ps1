Write-Host "[prove] Start backend in one terminal: npm run dev:backend"
Write-Host "[prove] Start frontend in another terminal: npm run dev:frontend"
Write-Host "[prove] Ensure XAMPP MySQL is running and backend/.env is configured (Gmail SMTP app password)."
node scripts/prove_e2e.mjs
