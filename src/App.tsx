import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import TeacherView from './pages/TeacherView';
import StudentView from './pages/StudentView';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TeacherView />} />
        <Route path="/join/:roomId" element={<StudentView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
